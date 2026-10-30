/**
 * Route tests for the public acquirer async-callback endpoint. Requires
 * DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate`
 * first).
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "acquirerCallbacks.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const ACQUIRER_SECRET = "acqsec_route_test_secret";

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ACQUIRER_CALLBACK_SIGNING_SECRET: ACQUIRER_SECRET,
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function createTransaction(): Promise<string> {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Acquirer Callback Route Merchant ${randomUUID()}`, 250],
  );
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 50000, 50000, $2)
     RETURNING id`,
    [merchantResult.rows[0]!.id, `acqref_${randomUUID()}`],
  );
  return txnResult.rows[0]!.id;
}

function callbackBody(transactionId: string, callbackId: string) {
  return {
    callbackId,
    type: "fraud_review.completed",
    transactionId,
    occurredAt: "2026-09-16T10:00:00.000Z",
    outcome: "confirmed_fraud",
    note: "Manual review flagged card testing pattern; recommend void.",
  };
}

// Fix 1.8: signs with "now" instead of a fixed 2025 date, because old timestamps are now rejected.
// إصلاح 1.8: نوقّع بالوقت الحالي بدل تاريخ ثابت من 2025، لأن التواريخ القديمة صارت تنرفض.
function signatureHeader(body: unknown, secret = ACQUIRER_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${JSON.stringify(body)}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function noteCount(callbackId: string): Promise<string> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM acquirer_callback_notes WHERE callback_id = $1`,
    [callbackId],
  );
  return result.rows[0]!.count;
}

test("POST /v1/acquirer/callbacks accepts a correctly-signed callback and records the note", async () => {
  const transactionId = await createTransaction();
  const callbackId = `acqcb_${randomUUID()}`;
  const body = callbackBody(transactionId, callbackId);

  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "acquirer-callback-signature": signatureHeader(body) },
    payload: body,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { received: true });
  assert.equal(await noteCount(callbackId), "1");
});

test("POST /v1/acquirer/callbacks rejects a body missing required fields", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    payload: { callbackId: `acqcb_${randomUUID()}`, type: "fraud_review.completed" },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_request");
});

/** Tamper = wrong HMAC. Missing header and stale timestamp are different cases (see below / not covered). */
test("POST /v1/acquirer/callbacks rejects a tampered signature", async () => {
  const transactionId = await createTransaction();
  const callbackId = `acqcb_${randomUUID()}`;
  const body = callbackBody(transactionId, callbackId);

  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "acquirer-callback-signature": signatureHeader(body, "acqsec_not_the_real_secret") },
    payload: body,
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_signature");
  assert.equal(res.json().message, "signature_mismatch");
  assert.equal(await noteCount(callbackId), "0");
});

// Changed (fix 1.8): this test used to assert that an UNSIGNED callback was
// accepted and recorded. That test was locking the bug in place. The route
// is public and the signature is its only authentication, so an unsigned
// callback must be rejected.
// تغيّر (إصلاح 1.8): الاختبار القديم كان يتأكد إن callback بدون توقيع
// ينقبل، يعني كان "يثبّت" الخطأ. الحين يتأكد إنه ينرفض.
test("POST /v1/acquirer/callbacks rejects a callback sent without a signature header", async () => {
  const transactionId = await createTransaction();
  const callbackId = `acqcb_${randomUUID()}`;

  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    payload: callbackBody(transactionId, callbackId),
  });

  assert.equal(res.statusCode, 401);
  assert.equal(await noteCount(callbackId), "0");
});

// New (fix 3.1): the acquirer redelivers the SAME callback; it must be
// recorded only once (both deliveries still answer 200).
// جديد (إصلاح 3.1): البنك يرسل نفس الرسالة مرتين، فلازم تنسجل مرة وحدة بس.
test("POST /v1/acquirer/callbacks records a redelivered callback only once", async () => {
  const transactionId = await createTransaction();
  const callbackId = `acqcb_${randomUUID()}`;
  const body = callbackBody(transactionId, callbackId);

  for (let i = 0; i < 2; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/acquirer/callbacks",
      headers: { "acquirer-callback-signature": signatureHeader(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(await noteCount(callbackId), "1");
});

// New (fix 1.8): an old genuine signature must be refused (replay).
// جديد (إصلاح 1.8): توقيع حقيقي بس قديم لازم ينرفض.
test("POST /v1/acquirer/callbacks rejects a stale (replayed) signature", async () => {
  const transactionId = await createTransaction();
  const callbackId = `acqcb_${randomUUID()}`;
  const body = callbackBody(transactionId, callbackId);

  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "acquirer-callback-signature": signatureHeader(body, ACQUIRER_SECRET, 1_757_930_000) },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(await noteCount(callbackId), "0");
});

test("POST /v1/acquirer/callbacks returns 404 for an unknown transaction id", async () => {
  const callbackId = `acqcb_${randomUUID()}`;
  const body = callbackBody(randomUUID(), callbackId);

  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "acquirer-callback-signature": signatureHeader(body) },
    payload: body,
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "transaction_not_found");
});