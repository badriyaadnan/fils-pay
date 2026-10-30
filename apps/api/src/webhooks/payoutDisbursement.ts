import type { Pool } from "pg";

/** Operational record of a payout-rail instruction for a settlement batch. */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  // Fix 3.4: no longer called by the dispatcher (see dispatcher.ts). Kept
  // safe anyway: one disbursement per batch (migration 0075).
  // إصلاح 3.4: ما عاد أحد يناديها، وحتى لو انندهت، ما تكتب أكثر من وحدة للدفعة.
  await pool.query(
    `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
     VALUES ($1, $2, 'disb_' || gen_random_uuid())
     ON CONFLICT (settlement_batch_id) WHERE duplicate_of IS NULL DO NOTHING`,
    [settlementBatchId, amountFils],
  );
}