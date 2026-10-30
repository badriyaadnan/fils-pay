// Fix 4.8 (FP-212 refunds): Test for the refund.succeeded envelope.
// إصلاح 4.8 (ميزة الاسترجاع): اختبار شكل رسالة الاسترجاع.

/**
 * buildEnvelope is the field-by-field mapper between an internal
 * outbox_events row and the public webhook body merchants integrate
 * against. Pure — no database needed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildEnvelope } from "./envelope.js";

test("settlement.paid maps to the documented public data shape", () => {
  const deliveryEventId = randomUUID();
  const batchId = randomUUID();
  const merchantId = randomUUID();
  const createdAt = new Date("2026-09-09T21:05:00.000Z");

  const envelope = buildEnvelope(deliveryEventId, {
    eventType: "settlement.paid",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-09-09", netPayoutFils: 471_300 },
    createdAt,
  });

  assert.deepEqual(envelope, {
    id: deliveryEventId,
    type: "settlement.paid",
    createdAt: "2026-09-09T21:05:00.000Z",
    data: {
      settlementBatchId: batchId,
      merchantId,
      batchDate: "2026-09-09",
      netPayoutFils: 471_300,
    },
  });
});

// MK: was refund.created before the rename
test("buildEnvelope rejects an event type it has no mapping for", () => {
  assert.throws(
    () =>
      buildEnvelope(randomUUID(), {
        eventType: "settlement.batch_closed",
        aggregateId: randomUUID(),
        payload: {},
        createdAt: new Date(),
      }),
    /unsupported event type/,
  );
});

// Added (FP-212): refund.succeeded has a public envelope, field by field.
test("buildEnvelope maps refund.succeeded to its public shape", () => {
  const env = buildEnvelope("dlv_1", {
    eventType: "refund.succeeded",
    aggregateId: "11111111-1111-4111-8111-111111111111",
    payload: {
      merchantId: "22222222-2222-4222-8222-222222222222",
      refundId: "33333333-3333-4333-8333-333333333333",
      amountFils: 2000,
      feeReversedFils: 50,
      refundedTotalFils: 2000,
      newStatus: "partially_refunded",
    },
    createdAt: new Date("2026-10-30T00:00:00.000Z"),
  });
  assert.equal(env.type, "refund.succeeded");
  assert.deepEqual(env.data, {
    transactionId: "11111111-1111-4111-8111-111111111111",
    merchantId: "22222222-2222-4222-8222-222222222222",
    refundId: "33333333-3333-4333-8333-333333333333",
    amountFils: 2000,
    feeReversedFils: 50,
    refundedTotalFils: 2000,
    status: "partially_refunded",
  });
});
