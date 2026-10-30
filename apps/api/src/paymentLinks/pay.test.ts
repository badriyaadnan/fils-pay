import assert from "node:assert/strict";
import { test } from "node:test";
import { expiryReferenceTime } from "./pay.js";

// Tolerance for comparing a freshly-minted Date against the test's own
// `Date.now()` — generous enough not to flake on a loaded CI box.
const TOLERANCE_MS = 5_000;

test("expiryReferenceTime: no value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime();
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

test("expiryReferenceTime: empty string -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("");
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

// Changed (fix 1.9): the old test checked that a timestamp from the browser
// is used for the expiry decision. That IS the bug (FP-187): it locked it in.
// Now we check the browser's timestamp is ignored and the server clock wins.
// تغيّر (إصلاح 1.9): الاختبار القديم كان يتأكد إن وقت المتصفح ينستخدم لفحص
// الانتهاء، وهذا هو الخطأ نفسه (كان يثبّته). الحين نتأكد إنه ينتجاهل
// ووقت السيرفر هو اللي يحكم.
test("expiryReferenceTime: a client-supplied timestamp is ignored (server clock wins)", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("2026-03-14T09:30:00.000Z");
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

test("expiryReferenceTime: an unparseable value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("not-a-timestamp");
  assert.ok(!Number.isNaN(resolved.getTime()));
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});