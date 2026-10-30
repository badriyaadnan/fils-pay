import type { Pool } from "pg";
import type { Config } from "../config.js";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { issueApiKeyInTx, type IssuedApiKey } from "../apiKeys/issue.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

export interface RotatedApiKey extends IssuedApiKey {
  previousKeyId: string;
}

/** Rotates a merchant's API key, atomically with its audit row. */
export async function rotateApiKeyAsAdmin(
  pool: Pool,
  config: Pick<Config, "nodeEnv">,
  input: { merchantId: string; apiKeyId: string; adminUserId: string; label?: string },
): Promise<RotatedApiKey> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string; label: string | null; revoked_at: Date | null }>(
      `SELECT id, label, revoked_at FROM api_keys WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.apiKeyId, input.merchantId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new NotFoundError("api_key_not_found");
    }
    if (row.revoked_at) {
      throw new ConflictError("api_key_already_revoked");
    }

    // Fix 1.10: rotation must actually KILL the old key. Before, nothing set
    // revoked_at, so a "rotated" key (usually rotated because it leaked) kept
    // working forever. We do it in the same transaction as issuing the new
    // key, so either both happen or neither does.
    // إصلاح 1.10: التدوير لازم "يموّت" المفتاح القديم فعلاً. قبل، ما أحد يحط
    // revoked_at، فالمفتاح القديم (اللي غالباً تسرّب) يظل شغال للأبد.
    // نسويها بنفس الـ transaction مع إصدار المفتاح الجديد، فيا يصيرون
    // الاثنين، يا ولا واحد.
    await client.query(
      `UPDATE api_keys SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`,
      [input.apiKeyId],
    );

    const issued = await issueApiKeyInTx(client, config, {
      merchantId: input.merchantId,
      createdByAdminUserId: input.adminUserId,
      label: input.label ?? row.label ?? undefined,
      rotatedFromKeyId: input.apiKeyId,
    });

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "api_key_rotate",
      targetType: "api_key",
      targetId: input.apiKeyId,
      metadata: { merchantId: input.merchantId, newKeyId: issued.id },
    });

    return { ...issued, previousKeyId: input.apiKeyId };
  });
}