import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireApiKey } from "../apiKeys/verify.js";
// Fix 1.6: also import requireMerchantRole, to block "support" from moving money.
// إصلاح 1.6: نستورد requireMerchantRole بعد، عشان نمنع "support" من تحريك الفلوس.
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { authorizeTransaction, type AuthorizeInput } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
// Fix 3.7: stream the CSV export instead of building it all in memory.
// إصلاح 3.7: نرسل ملف التصدير قطعة قطعة بدل ما نبنيه كله في الذاكرة.
import { Readable } from "node:stream";
import { streamTransactionsExportCsvChunks } from "../transactions/exportCsv.js";
import { getTransactionById, listTransactions } from "../transactions/query.js";
import { listTransactionEvents } from "../transactions/events.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface AuthorizeBody {
  amountFils?: number;
  card?: SimulatedCardInput;
  reference?: string;
}

interface CaptureBody {
  amountFils?: number;
}

interface TransactionIdParams {
  id: string;
}

/** from/to: ISO-8601 instants (not business dates). Invalid values are rejected with 400. */
interface ExportQuery {
  status?: string | string[];
  from?: string;
  to?: string;
}

interface ListTransactionsQuery {
  status?: string | string[];
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
  cursor?: string;
}

/**
 * Reads the Idempotency-Key header. Required on authorize and capture;
 * void is naturally idempotent and does not call this. Keys are scoped per
 * merchant + endpoint (see payments/idempotency.ts), so the same key may be
 * reused across endpoints without colliding.
 */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Registered with prefix '/v1/transactions'. Endpoint auth: authorize is
 * API-key-only (a server-to-server "charge a
 * card" call); capture/void/reads accept either a session or an API key
 * via `requireMerchantAuth`.
 */
export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AuthorizeBody }>(
    "/",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils, card, reference } = request.body ?? {};
      if (amountFils === undefined || !card) {
        throw new BadRequestError("invalid_request", "amountFils and card are required");
      }

      const input: AuthorizeInput = {
        merchantId: request.apiKeyAuth!.merchantId,
        amountFils: toFils(amountFils),
        card,
        reference,
        idempotencyKey,
        actor: { type: "merchant_api_key", id: request.apiKeyAuth!.apiKeyId },
      };
      const result = await authorizeTransaction(app.db, app.acquirer, input);
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams; Body: CaptureBody }>(
    // am: requireMerchantAuth lets impersonation through here too? an admin impersonating can capture
    // MK: impersonation is read-only, enforced in requireMerchantAuth. fine
    // MK: confirmed — ADMIN.md says grants are support-level read only
    "/:id/capture",
    // Fix 1.6: capture moves money, so only owner/finance may do it. A "support"
    // user (and an admin impersonating, who is always "support") gets 403.
    // The comments above say "impersonation is read-only": that was never enforced.
    // إصلاح 1.6: السحب يحرك فلوس، فبس owner/finance يقدرون. مستخدم "support"
    // (والأدمن اللي ينتحل، دايماً "support") ياخذ 403. التعليقات فوق تقول
    // "الانتحال قراءة بس"، بس هذا عمره ما انطبق في الكود.
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils } = request.body ?? {};

      const result = await captureTransaction(app.db, app.acquirer, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        amountFils: amountFils !== undefined ? toFils(amountFils) : undefined,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      // Fix 2.12: the negotiated discount is now part of the fee computed
      // INSIDE captureTransaction's own transaction (same formula as
      // settlement), so there is no separate post-capture adjustment here.
      // (am's worry was right: if that separate step failed, the capture was
      // committed but the discount never landed.)
      // إصلاح 2.12: الخصم صار داخل حساب الرسوم في captureTransaction نفسها
      // (نفس معادلة التسوية)، فما نحتاج خطوة خصم منفصلة هني. (AM كانت صح:
      // لو الخطوة المنفصلة فشلت، السحب يصير بس الخصم ما يوصل أبداً.)
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams }>(
    "/:id/void",
    // Fix 1.6: void also moves money (releases the hold), so same rule as capture.
    // إصلاح 1.6: الإلغاء يحرك فلوس بعد (يفك الحجز)، فنفس شرط السحب.
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const result = await voidTransaction(app.db, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: ListTransactionsQuery }>(
    "/",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;

      return listTransactions(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        status,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        search: q.search,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  app.get<{ Querystring: ExportQuery }>(
    "/export",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];

      // Fix 3.7: streamed page by page instead of building the whole CSV in
      // memory (a big merchant could exhaust our 2 GB server).
      // إصلاح 3.7: صفحة صفحة بدل ما نبني الملف كله في الذاكرة.
      const chunks = streamTransactionsExportCsvChunks(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        status,
      });

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="transactions.csv"')
        .send(Readable.from(chunks));
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      return txn;
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id/events",
    { preHandler: requireMerchantAuth },
    async (request) => {
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent transaction isn't found/owned).
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      // existence check above is the ownership check. correct — FH
      return listTransactionEvents(app.db, request.params.id);
    },
  );
}