// Fix 4.1 (FP-212 refunds): The refunds route used to answer 501 "not implemented". Now POST /v1/refunds AND POST /v1/merchants/:merchantId/refunds (what the dashboard calls) both work: Idempotency-Key required, owner/finance or API key only, amount in integer fils.
// إصلاح 4.1 (ميزة الاسترجاع): رابط الاسترجاع كان يرد 501 "مو مبني". الحين الرابطين يشتغلون: /v1/refunds و/v1/merchants/:id/refunds (اللي تناديه اللوحة). لازم Idempotency-Key، وبس owner/finance أو API key.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils, type Fils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

/**
 * FP-212 / FP-300 — Refunds (full and partial).
 *
 * Two entry points, one implementation:
 *   POST /v1/refunds                       — partner/API-key style; the
 *                                            merchant is the authenticated one
 *   POST /v1/merchants/:merchantId/refunds — what the dashboard RefundDrawer
 *                                            calls (path scope-checked)
 *
 * Body: { transactionId, amountFils?, reason? }. amountFils is an integer
 * number of fils (1 BD = 1000 fils); omitted = everything still refundable.
 * Header: Idempotency-Key (required) — a client retry with the same key
 * replays the first answer instead of refunding twice.
 *
 * Money-moving: owner/finance sessions or an API key only (never support,
 * never an impersonation grant).
 */
interface RefundBody {
  transactionId?: string;
  amountFils?: unknown;
  reason?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

function parseBody(body: RefundBody | undefined): { transactionId: string; amountFils?: Fils; reason?: string } {
  const transactionId = body?.transactionId;
  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId (uuid) is required");
  }
  let amountFils: Fils | undefined;
  if (body?.amountFils !== undefined && body.amountFils !== null) {
    if (typeof body.amountFils !== "number") {
      throw new BadRequestError("invalid_amount", "amountFils must be an integer number of fils");
    }
    try {
      amountFils = toFils(body.amountFils);
    } catch (err) {
      throw new BadRequestError("invalid_amount", err instanceof Error ? err.message : String(err));
    }
  }
  let reason: string | undefined;
  if (body?.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.length > 500) {
      throw new BadRequestError("invalid_reason", "reason must be a string of at most 500 characters");
    }
    reason = body.reason;
  }
  return amountFils === undefined
    ? reason === undefined
      ? { transactionId }
      : { transactionId, reason }
    : reason === undefined
      ? { transactionId, amountFils }
      : { transactionId, amountFils, reason };
}

async function handleRefund(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, merchantId: string) {
  const idempotencyKey = getIdempotencyKey(request);
  const parsed = parseBody(request.body as RefundBody | undefined);
  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    merchantId,
    transactionId: parsed.transactionId,
    ...(parsed.amountFils !== undefined ? { amountFils: parsed.amountFils } : {}),
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    idempotencyKey,
    actor: requireMerchantWriterActor(request.merchantAuth!),
  });
  reply.code(result.statusCode).send(result.body);
}

/** Registered with prefix '/v1/refunds'. */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => handleRefund(app, request, reply, request.merchantAuth!.merchantId),
  );
}

/** Registered with prefix '/v1/merchants'. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { merchantId: string } }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      return handleRefund(app, request, reply, request.params.merchantId);
    },
  );
}
