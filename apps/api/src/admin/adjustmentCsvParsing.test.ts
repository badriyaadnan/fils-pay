/**
 * Unit tests for the adjustment CSV parser. Pure — no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils, parseAdjustmentCsv } from "./adjustmentCsvParsing.js";

test("a non-numeric amount throws", () => {
  assert.throws(() => parseAdjustmentAmountFils("not-a-number"), /could not parse amount/);
});

test("an empty amount throws", () => {
  assert.throws(() => parseAdjustmentAmountFils(""), /could not parse amount/);
});

// Added (fix 2.1): BD amounts have 3 decimals (1 BD = 1000 fils, ADR-0001).
// مضاف (إصلاح 2.1): الدينار 3 خانات (1 دينار = 1000 فلس).
test("BD amounts parse to whole fils (three decimals)", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
  assert.equal(parseAdjustmentAmountFils("10"), 10000);
  assert.equal(parseAdjustmentAmountFils("-1.25"), -1250);
});

// More than 3 decimals must be rejected, never silently cut.
// أكثر من 3 خانات لازم ينرفض، مو ينقص بدون ما أحد يدري.
test("more than three decimals is rejected, not truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});

// ------------------------------------------------------------ csv splitting

const MERCHANT_A = "11111111-1111-4111-8111-111111111111";
const MERCHANT_B = "22222222-2222-4222-8222-222222222222";

test("a well-formed CSV splits into rows", () => {
  const rows = parseAdjustmentCsv(
    `merchantId,amount,reason\n${MERCHANT_A},4.750,statement correction\n${MERCHANT_B},-1.250,duplicate refund\n`,
  );
  assert.deepEqual(rows, [
    { merchantId: MERCHANT_A, amount: "4.750", reason: "statement correction" },
    { merchantId: MERCHANT_B, amount: "-1.250", reason: "duplicate refund" },
  ]);
});

test("a row with no reason column omits the reason", () => {
  const rows = parseAdjustmentCsv(`merchantId,amount,reason\n${MERCHANT_A},4.750\n`);
  assert.deepEqual(rows, [{ merchantId: MERCHANT_A, amount: "4.750" }]);
});

test("blank lines are ignored", () => {
  const rows = parseAdjustmentCsv(`merchantId,amount,reason\n\n${MERCHANT_A},1.000,x\n\n`);
  assert.equal(rows.length, 1);
});

test("a CSV with only a header throws", () => {
  assert.throws(() => parseAdjustmentCsv("merchantId,amount,reason\n"), /at least one data row/);
});

test("an empty CSV throws", () => {
  assert.throws(() => parseAdjustmentCsv("   \n  \n"), /at least one data row/);
});

test("a wrong header throws", () => {
  assert.throws(
    () => parseAdjustmentCsv(`merchant,value,note\n${MERCHANT_A},4.750,x\n`),
    /header must be merchantId,amount,reason/,
  );
});

test("a row missing its amount throws", () => {
  assert.throws(() => parseAdjustmentCsv(`merchantId,amount,reason\n${MERCHANT_A},,x\n`), /missing a merchantId or an amount/);
});