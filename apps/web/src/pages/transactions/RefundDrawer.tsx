// Fix 6.5: newIdempotencyKey() instead of crypto.randomUUID() (undefined over plain HTTP on the server).
// إصلاح 6.5: newIdempotencyKey() بدل crypto.randomUUID() (ما يشتغل على HTTP في السيرفر).
// Fix 4.8 (UI) (FP-212 refunds): The parked drawer is restored and fixed: right URL, amount typed in BD (not raw fils), ceiling = still refundable, partially refunded can be refunded again, ONE idempotency key per attempt (a retry can never refund twice).
// إصلاح 4.8 (UI) (ميزة الاسترجاع): رجّعنا نافذة الاسترجاع وصلحناها: الرابط الصح، المبلغ بالدينار (مو بالفلس)، الحد = الباقي، والضغط مرتين ما يسترجع مرتين.

import { useState } from "react";
import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";
import { request } from "../../api/client.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";
import { newIdempotencyKey } from "../../utils/idempotencyKey.js";

/**
 * FP-212 refund control on the transaction detail page. Restored now that
 * the route exists (POST /v1/merchants/:merchantId/refunds).
 *
 * Fixes over the parked version:
 *  - the amount is typed in BD ("2.500") and converted with parseBhdToFils,
 *    instead of a raw fils number a merchant would easily get 1000x wrong;
 *  - the ceiling shown and enforced is what is still refundable
 *    (captured - refunded), not the captured total;
 *  - a partially refunded transaction can still be refunded further;
 *  - ONE Idempotency-Key per refund attempt, reused if the same request is
 *    retried after a network error, so a retry can never refund twice.
 *    A new key is made only after a definitive answer or an edit.
 */
interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState<string>(() => newIdempotencyKey());

  const merchantId = me?.merchant.id;
  const refundableFils = Math.max(0, txn.capturedFils - (txn.refundedFils ?? 0));
  const refundable = REFUNDABLE_STATUSES.has(txn.status) && refundableFils > 0;

  function edit(value: string): void {
    setAmount(value);
    setAttemptKey(newIdempotencyKey()); // a different request gets a different key
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;

    const trimmed = amount.trim();
    let amountFils: number | undefined;
    if (trimmed !== "") {
      try {
        amountFils = parseBhdToFils(trimmed);
      } catch {
        setError("Enter an amount in BD with at most three decimals, e.g. 2.500");
        return;
      }
      if (amountFils <= 0 || amountFils > refundableFils) {
        setError(`Amount must be between 0.001 and ${bhd(refundableFils)}`);
        return;
      }
    }
    const shown = bhd(amountFils ?? refundableFils);
    if (!window.confirm(`Refund ${shown}? The money goes back to the cardholder and cannot be recalled.`)) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const body = amountFils === undefined ? { transactionId: txn.id } : { transactionId: txn.id, amountFils };
      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": attemptKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setOpen(false);
      setAmount("");
      setAttemptKey(newIdempotencyKey());
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in BD (blank refunds everything still refundable)
              <input
                type="text"
                inputMode="decimal"
                placeholder={formatBhd(toFils(refundableFils))}
                value={amount}
                onChange={(e) => edit(e.target.value)}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(refundableFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
