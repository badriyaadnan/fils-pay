// Fix 2.1: use parseBhdToFils (3 decimals, 1 BD = 1000 fils) instead of
// toFils + parseDecimalMinor (which assumed 2 decimals, "cents").
// إصلاح 2.1: نستخدم parseBhdToFils (3 خانات، 1 دينار = 1000 فلس) بدل
// toFils + parseDecimalMinor (اللي يحسبها خانتين "cents").
import { parseBhdToFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/** Parses one CSV row's BD amount column into fils. */
// Before: "4.75" became 475 fils (0.475 BD), 10x too small, and "4.755"
// was silently cut to 475. Now: "4.75" = 4750, "4.755" = 4755, and more
// than 3 decimals (e.g. "4.7555") is rejected instead of cut.
// قبل: "4.75" تصير 475 فلس (0.475 دينار)، أصغر 10 مرات، و"4.755" تنقص
// بدون ما أحد يدري. الحين: "4.75" = 4750، و"4.755" = 4755، وأكثر من 3
// خانات (مثل "4.7555") ينرفض بدل ما ينقص.
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    return parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_amount", `could not parse amount "${raw}"`);
  }
}

export interface ParsedAdjustmentCsvRow {
  merchantId: string;
  amount: string;
  reason?: string;
}

/**
 * Splits the uploaded CSV text into rows. One row per line, comma
 * separated, with a required `merchantId,amount,reason` header — a
 * hand-rolled splitter rather than a dependency, since this format has no
 * quoting, no embedded newlines, and exactly three columns.
 */
export function parseAdjustmentCsv(csvContent: string): ParsedAdjustmentCsvRow[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  const header = (lines[0] as string).split(",").map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }

  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(",").map((cell) => cell.trim());
    const merchantId = cells[0] ?? "";
    const amount = cells[1] ?? "";
    if (merchantId === "" || amount === "") {
      throw new BadRequestError("invalid_csv_row", `row ${i} is missing a merchantId or an amount`);
    }
    const reason = cells[2];
    rows.push(reason === undefined || reason === "" ? { merchantId, amount } : { merchantId, amount, reason });
  }

  if (rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  return rows;
}