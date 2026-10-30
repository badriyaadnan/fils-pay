// Fix 4.2 / 4.3 / 4.5 / 4.6 (FP-212 refunds): 4.2 two refunds at the same moment both passed (validate, then acquirer, then journal in separate transactions); now ONE transaction with the row locked. 4.3 the ceiling was authorized-refunded; now captured-refunded. 4.5 partial refunds reverse the fee cumulatively so they always add up to the fee charged. 4.6 reason NULL broke the NOT NULL rule; default "unspecified".
// إصلاح 4.2 / 4.3 / 4.5 / 4.6 (ميزة الاسترجاع): 4.2 استرجاعين بنفس اللحظة كانوا ينجحون الاثنين (فلوس تطلع مرتين)؛ الحين عملية وحدة مقفولة. 4.3 كان يسمح يسترجع لين المبلغ "المحجوز"؛ الحين بس "المسحوب". 4.5 رسوم الاسترجاع الجزئي تنحسب تراكمياً عشان مجموعها = الرسوم الأصلية بالضبط. 4.6 السبب الفاضي كان يطيّح؛ الحين "unspecified".

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

export interface ProcessRefundInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/**
 * Refund business logic: validate, call the acquirer, journal the reversal —
 * all in ONE transaction that holds the transaction row lock (FOR UPDATE)
 * across the acquirer call, exactly like capture.ts does.
 *
 * Fixed (FP-209 "concurrent refund: double money out"): the old version
 * validated in one transaction, called the acquirer with no lock held, and
 * journaled in a second transaction using the refunded total it had read in
 * the first. Two requests with different idempotency keys both passed
 * validation and both refunded. With the row locked for the whole flow the
 * second request waits, then validates against the updated refunded_fils.
 *
 * Also fixed:
 *  - the refundable ceiling was authorized minus refunded; it is CAPTURED
 *    minus refunded (you cannot return money that was never taken);
 *  - the transaction is looked up WITH the merchant id, so a merchant can
 *    never refund another merchant's transaction;
 *  - partial refunds reverse the fee cumulatively, so the reversals of a
 *    fully refunded transaction always sum to exactly the fee charged;
 *  - reason defaults to 'unspecified' (migration 0070's NOT NULL check).
 */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }

    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { statusCode: 404, body };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));
    const refundableFils =
      compareFils(capturedFils, refundedFils) > 0 ? subtractFils(capturedFils, refundedFils) : ZERO_FILS;

    const validation = validateRefundRequest(
      {
        id: txn.id,
        merchantId: txn.merchant_id,
        status: txn.status,
        capturedFils,
        refundableFils,
      },
      input.amountFils,
    );

    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { statusCode, body: validation };
    }

    // The fee this transaction was actually charged at capture, read from
    // the ledger (net of any capture-time discount rebate, excluding earlier
    // refund reversals), never recomputed from today's rate.
    const feeResult = await client.query<{ fee_fils: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS fee_fils
         FROM ledger_entries
        WHERE transaction_id = $1
          AND account_id = 'platform_fee_revenue'
          AND description NOT LIKE 'refund:%'`,
      [txn.id],
    );
    const feeChargedRaw = Number(feeResult.rows[0]?.fee_fils ?? 0);
    const feeChargedFils = toFils(Math.max(0, feeChargedRaw));
    const requestedAmount = validation.amountFils;

    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: requestedAmount,
      idempotencyKey: `${claim.row.id}:${claim.row.attemptCount}`,
    });

    const prepared = {
      claimId: claim.row.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountAuthorized,
      capturedFils,
      refundedFils,
      feeChargedFils,
      requestedAmount,
    };

    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, prepared.claimId, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const newRefundedTotal = addFils(prepared.refundedFils, prepared.requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: prepared.amountAuthorized,
      capturedFils: prepared.capturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    // Cumulative proportional reversal: fee share of everything refunded so
    // far, minus the share already reversed. Rounding each partial on its
    // own could reverse a fil more or less than was charged in total.
    const feeReversedFils = subtractFils(
      calculateRefundFee(prepared.capturedFils, prepared.feeChargedFils, newRefundedTotal),
      calculateRefundFee(prepared.capturedFils, prepared.feeChargedFils, prepared.refundedFils),
    );

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        prepared.transactionId,
        prepared.merchantId,
        prepared.requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    await client.query(`UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, [
      prepared.transactionId,
      newRefundedTotal,
      newStatus,
    ]);

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, prepared.merchantId, prepared.transactionId, prepared.requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, prepared.merchantId, prepared.transactionId, feeReversedFils],
      );
    }

    // The timeline records what this refund did to the captured amount, so
    // it stays readable regardless of what the status column ends up
    // saying: everything captured has now gone back, or only part of it has.
    const eventType = compareFils(newRefundedTotal, prepared.capturedFils) >= 0 ? "refunded" : "refund_partial";

    await recordTransactionEvent(client, {
      transactionId: prepared.transactionId,
      eventType,
      amountFils: toFils(-prepared.requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: prepared.transactionId,
      payload: {
        merchantId: prepared.merchantId,
        refundId: refund.id,
        amountFils: prepared.requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: prepared.transactionId,
      merchantId: prepared.merchantId,
      amountFils: prepared.requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, prepared.claimId, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  });
}
