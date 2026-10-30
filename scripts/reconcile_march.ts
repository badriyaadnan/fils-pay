#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it. Run manually, once — see
 * scripts/out/reconcile-2026-03.log for the last real run's output.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

// Fix 2.14 — this one-off script had 3 bugs:
//   (1) wrong month: it used the UTC month, not the Bahrain month;
//   (2) wrong accounts: it CHARGED each merchant (debit merchant_payable)
//       for rounding the platform itself had absorbed;
//   (3) not safe to re-run: am's "entry_group_id dedupes it" was false,
//       so a second run doubled the correction (that happened on staging).
// إصلاح 2.14 — هالسكربت (يشتغل مرة وحدة) كان فيه 3 أخطاء:
//   (1) الشهر غلط: يستخدم شهر UTC مو شهر البحرين،
//   (2) الحسابات غلط: "يخصم" من كل تاجر (مدين merchant_payable) فروقات
//       تقريب المنصة هي اللي تحملتها،
//   (3) مو آمن لو انعاد تشغيله: كلام AM "entry_group_id يمنع التكرار" غلط،
//       فالتشغيل الثاني يضاعف التصحيح (وهذا صار فعلاً في staging).

/** Asia/Bahrain is a fixed UTC+3 (no DST since 1972). */
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * [start, end) of the BAHRAIN calendar month, as UTC instants. The batches
 * this script reconciles against are Bahrain business days, so a UTC month
 * moved the first three Bahrain hours of March into February and pulled
 * the first three hours of April in (HANDOVER "March close": "must use the
 * Bahrain month, not a UTC month").
 *
 * (1) شهر البحرين يبدأ 21:00 UTC يوم 28 فبراير، مو 00:00 UTC يوم 1 مارس.
 */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAHRAIN_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAHRAIN_OFFSET_MS),
  };
}

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
// MK: % 10 on a non-negative int. correct.
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

async function fetchResidueRows(client: Client, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{ merchant_id: string; captured_fils: string }>(
    `SELECT merchant_id, captured_fils
       FROM transactions
      WHERE captured_fils > 0
        AND captured_fils % 10 <> 0
        AND occurred_at >= $1 AND occurred_at < $2
      ORDER BY merchant_id, occurred_at`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows.map((r) => ({ merchantId: r.merchant_id, capturedFils: Number(r.captured_fils) }));
}

/**
 * One correction group per merchant. lineCount is the number of transactions
 * with a non-zero residue, not the number of scheme lines.
 */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.capturedFils);
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

export const SWEEP_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";

/**
 * Posts one merchant's residue with the legs ADR-0002 specifies: CREDIT
 * card_scheme_clearing (the fils the scheme never paid us), DEBIT
 * scheme_rounding_residue (suspense, cleared monthly by finance).
 *
 * The old legs DEBITED merchant_payable — charging each merchant the
 * rounding the platform had absorbed — and credited the suspense account,
 * i.e. the wrong account and the wrong direction.
 *
 * (2) الصح: دائن card_scheme_clearing، ومدين scheme_rounding_residue.
 * القديم كان يخصم من رصيد التاجر، وهذا غلط في الحساب والاتجاه.
 */
async function postResidueCorrection(client: Client, merchant: MerchantResidue, now: Date): Promise<void> {
  if (merchant.residueFils <= 0) return;
  const entryGroupId = randomUUID();
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing',    'credit', $3, $4, $5),
            ($1, $2, 'scheme_rounding_residue', 'debit',  $3, $4, $5)`,
    [entryGroupId, merchant.merchantId, merchant.residueFils, now.toISOString(), SWEEP_DESCRIPTION],
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // FH: the log says 'run at ...+03:00' but toISOString is always Z?? MK: different node version
  const now = new Date();

  try {
    const rows = await fetchResidueRows(client, 2026, 3);
    const merchantResidues = groupByMerchant(rows);
    const totalResidueFils = merchantResidues.reduce((sum, m) => sum + m.residueFils, 0);

    const { start, end } = monthBounds(2026, 3);
    console.log("=== March 2026 reconciliation sweep ===");
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window: ${start.toISOString().slice(0, 10)} .. ${end.toISOString().slice(0, 10)}`);
    console.log("");

    await client.query("BEGIN");
    try {
      // Not idempotent by construction (a fresh entry_group_id per run, so
      // "entry_group_id dedupes it" was never true): a second run doubles the
      // correction, which is what happened on staging. Refuse to run twice.
      // Serialize concurrent runs, then check for an earlier sweep.
      // (3) نقفل عشان ما يشتغل مرتين بنفس الوقت، ونرفض إذا انسوى قبل.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('reconcile_march_2026'))");
      const already = await client.query(`SELECT 1 FROM ledger_entries WHERE description = $1 LIMIT 1`, [
        SWEEP_DESCRIPTION,
      ]);
      if ((already.rowCount ?? 0) > 0) {
        throw new Error(
          "reconcile_march: the March sweep has already been posted; refusing to post it again. " +
            "If an earlier run used the old (wrong) legs, finance must reverse it with an explicit correcting entry.",
        );
      }
      for (const merchant of merchantResidues) {
        await postResidueCorrection(client, merchant, now);
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)`,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log("---");
    console.log(`total lines matched: ${rows.length}`);
    console.log(`total residue swept: ${formatBhd(toFils(totalResidueFils))} BD (${totalResidueFils} fils)`);
    console.log("");
    console.log("reconciliation applied successfully");
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