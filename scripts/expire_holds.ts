#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that is never captured or released stays
 * 'active' past its expires_at. This flips such holds to 'expired' with ONE
 * conditional UPDATE (HANDOVER "Holds": holds are never deleted).
 *
 * Fix 2.13 — the previous version:
 *   1. SELECTed the expired ids, then DELETEd them by id. On a night with
 *      nothing expired the id list was empty, buildWhere() dropped the empty
 *      array, and the statement became `DELETE FROM holds` — every hold,
 *      including active ones, gone.
 *   2. Deleted rows instead of marking them, destroying the audit trail.
 *   3. Had a window between SELECT and DELETE in which a hold could be
 *      captured and still get deleted.
 * The single UPDATE re-checks status and expiry atomically per row.
 *
 * إصلاح 2.13 — النسخة القديمة كان فيها 3 مشاكل:
 *   1. تجيب أرقام الحجوزات المنتهية، وبعدين تمسحها بالأرقام. بس في ليلة ما
 *      فيها ولا حجز منتهي، القائمة فاضية، وbuildWhere يتجاهل القائمة
 *      الفاضية، فيصير الأمر `DELETE FROM holds` بدون شرط، ويمسح "كل"
 *      الحجوزات، حتى الشغالة!
 *   2. كانت "تمسح" بدل ما "تعلّم" (والقاعدة: الحجوزات ما تنمسح أبداً)،
 *      فيضيع السجل.
 *   3. فيه وقت بين الجلب والمسح، ممكن حجز ينسحب فيه وبعدين ينمسح.
 * الحين: أمر UPDATE واحد يعلّم الحجوزات المنتهية بـ 'expired'، ويشيّك الحالة
 * والوقت لكل صف بنفس اللحظة.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const EXPIRE_HOLDS_SQL =
  "UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(EXPIRE_HOLDS_SQL);
    console.log(`expire_holds: marked ${result.rowCount ?? 0} abandoned hold(s) expired`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}