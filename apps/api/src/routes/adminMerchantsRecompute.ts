// Fix 2.19 (finance memo: "Test merchants keep showing up in the real settlement run";
// incident log: "what happens to test merchants when certain admin tools run?").
// "Recompute transaction statuses" also called reconcileSandboxFlag, which set
// test_mode = false whenever it scanned any transaction with no open
// authorizations. The scan skips 'authorized' rows, so openAuthorizations was
// always 0: one click switched every sandbox merchant to LIVE, and the daily
// close (batch.go: test_mode = false) then settled and paid out its fake
// sandbox transactions as real money. A status recompute must never change a
// merchant's mode, so the flag change is removed.
// إصلاح 2.19: زر "إعادة حساب حالات العمليات" في لوحة الإدارة كان يحوّل التاجر
// التجريبي (test_mode) إلى تاجر حقيقي بدون ما أحد يطلب. والفحص ما يشوف العمليات
// 'authorized' أصلاً، فالعدد دايماً 0، يعني ضغطة وحدة تحوّل أي تاجر تجريبي لحقيقي،
// وبعدها التسوية اليومية تدفع له فلوس حقيقية عن عمليات تجريبية. الحين الزر ما يغيّر
// نوع التاجر أبداً.
import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { merchantExists, UUID_RE } from "../admin/merchants.js";
import { recomputeTransactionStatusesForMerchant } from "../admin/transactionStatusRecompute.js";
import { withTransaction } from "../db/withTransaction.js";
import { NotFoundError, UnauthorizedError } from "../lib/errors.js";

interface MerchantIdParams {
  id: string;
}

export async function adminMerchantsRecomputeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams }>(
    "/:id/transactions/recompute-statuses",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");
      if (!UUID_RE.test(request.params.id)) throw new NotFoundError("merchant_not_found");
      if (!(await merchantExists(app.db, request.params.id))) {
        throw new NotFoundError("merchant_not_found");
      }

      const result = await withTransaction(app.db, async (client) => {
        const recompute = await recomputeTransactionStatusesForMerchant(client, request.params.id);
        // Never touch test_mode here (kept in the response for the admin UI).
        // ما نغيّر test_mode هني أبداً (نخلي الحقل في الرد عشان الواجهة).
        const flagsUpdated: string[] = [];
        await insertAdminAuditLog(client, {
          adminUserId: adminAuth.adminUserId,
          action: "transaction_status_recompute",
          targetType: "merchant",
          targetId: request.params.id,
          metadata: {
            scanned: recompute.scanned,
            updated: recompute.updated,
            flagsUpdated,
          },
        });
        return { ...recompute, flagsUpdated };
      });

      reply.code(200).send(result);
    },
  );
}