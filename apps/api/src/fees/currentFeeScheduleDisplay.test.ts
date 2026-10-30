/**
 * Tests for the admin merchant-detail page's "current negotiated rate"
 * lookup, against a real, migrated Postgres (no DB mocking) — same posture
 * as feeSchedule.test.ts alongside it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getCurrentFeeScheduleForDisplay } from "./currentFeeScheduleDisplay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "currentFeeScheduleDisplay.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function insertMerchant(mdrBps: number): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Current Fee Schedule Test ${randomUUID()}`, mdrBps],
  );
  return result.rows[0]!.id;
}

async function insertSchedule(
  merchantId: string,
  mdrBps: number,
  effectiveFrom: string,
  createdAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES ($1, $2, $3, $4)`,
    [merchantId, mdrBps, effectiveFrom, createdAt],
  );
}

test("returns null for a merchant with no negotiated schedule on file", async () => {
  const merchantId = await insertMerchant(250);
  assert.equal(await getCurrentFeeScheduleForDisplay(pool, merchantId), null);
});

test("returns the row's own rate and dates when a single schedule exists", async () => {
  const merchantId = await insertMerchant(250);
  await insertSchedule(merchantId, 200, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 200);
  assert.equal(current?.effectiveFrom.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(current?.createdAt.toISOString(), "2026-06-01T00:00:00.000Z");
});

/** When rows are entered in effective order, created_at and effective_from agree, so either ordering passes this. */
test("returns the most recently entered schedule when rows were entered as they took effect", async () => {
  const merchantId = await insertMerchant(250);
  await insertSchedule(merchantId, 200, "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
  await insertSchedule(merchantId, 180, "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 180);
  assert.equal(current?.createdAt.toISOString(), "2026-07-01T00:00:00.000Z");
});

// Changed (fix 2.11): this test asserted the BUG: that a backfilled
// correction to an old period (245) is shown as "current" while billing uses
// 225. The display must show the rate actually charged now (the newest row in effect).
// تغيّر (إصلاح 2.11): الاختبار القديم كان يثبّت الخطأ (يعرض 245 والفعلي
// 225). الحين يتأكد إنه يعرض النسبة اللي تنخصم فعلاً.
test("shows the rate in effect now even when an older period was backfilled later", async () => {
  const merchantId = await insertMerchant(250);
  // A renegotiation entered on the day it took effect, then a backdated
  // correction to an earlier period entered two weeks afterwards.
  await insertSchedule(merchantId, 225, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
  await insertSchedule(merchantId, 245, "2026-03-01T00:00:00Z", "2026-08-15T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 225);
  assert.equal(current?.effectiveFrom.toISOString(), "2026-08-01T00:00:00.000Z");
});

// New (fix 2.11): a rate that starts in the future isn't "current" yet.
// جديد (إصلاح 2.11): نسبة تبدأ في المستقبل مو "الحالية".
test("a future-dated schedule is not shown as current", async () => {
  const merchantId = await insertMerchant(250);
  await insertSchedule(merchantId, 200, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  await insertSchedule(merchantId, 150, "2099-01-01T00:00:00Z", "2026-02-01T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 200);
});