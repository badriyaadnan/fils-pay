/**
 * Unit tests for the inbound acquirer-callback signature verifier. Pure
 * function, no database — the route-level behavior it drives is covered in
 * routes/acquirerCallbacks.test.ts.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";

const SECRET = "acqsec_test_secret";
// Fix 1.8: a fixed "now" so the time check is predictable in tests.
// إصلاح 1.8: وقت ثابت عشان فحص الوقت يكون متوقع في الاختبارات.
const NOW = 1_757_930_000;

/** Builds the header the acquirer would send for a given payload — the same
 *  `t=<seconds>,v1=<hex>` shape webhooks/sign.ts uses outbound. */
function acquirerHeader(payload: unknown, secret: string, timestamp = 1_757_930_000): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("a correctly-signed callback verifies", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, acquirerHeader(payload, SECRET), SECRET, true, NOW);
  assert.deepEqual(result, { valid: true });
});

test("a tampered payload is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, SECRET);
  const result = verifyAcquirerCallbackSignature({ callbackId: "acqcb_1", outcome: "confirmed_fraud" }, header, SECRET, true, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("the wrong secret is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, "acqsec_someone_elses_secret");
  const result = verifyAcquirerCallbackSignature(payload, header, SECRET, true, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("a malformed header is rejected (malformed_header)", () => {
  const payload = { callbackId: "acqcb_1" };
  assert.equal(verifyAcquirerCallbackSignature(payload, "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(payload, "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(payload, "v1=deadbeef", SECRET).reason, "malformed_header");
});

// Changed (fix 1.8): the old test asserted that an UNSIGNED callback was
// accepted by default (it locked the bug in). Now the default is to reject.
// تغيّر (إصلاح 1.8): الاختبار القديم كان يثبّت الخطأ (يقبل بدون توقيع).
// الحين الافتراضي هو الرفض.
test("an unsigned callback is rejected by default", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, undefined, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "malformed_header");
});

test("an unsigned callback is accepted only when checking is explicitly disabled", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  assert.deepEqual(verifyAcquirerCallbackSignature(payload, undefined, SECRET, false), { valid: true });
});

test("a correctly-signed but stale callback is rejected (replay)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, acquirerHeader(payload, SECRET), SECRET, true, NOW + 3600);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "timestamp_out_of_tolerance");
});