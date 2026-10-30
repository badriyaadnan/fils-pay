import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  // Fix 1.12 (CSV injection): in Excel/Sheets, a cell that starts with
  // = + - @ (or tab / carriage return) is run as a FORMULA. The reference
  // text comes from outside, so an attacker could make the file run a formula
  // when the accountant opens it. We put a ' in front so it shows as plain text.
  // إصلاح 1.12 (حقن CSV): في Excel، أي خانة تبدا بـ = + - @ (أو tab أو
  // سطر جديد) تنحسب كمعادلة. نص الـ reference يجي من برا، فالمهاجم يقدر
  // يخلي الملف يشغّل معادلة لما المحاسب يفتحه. نحط ' قدامه عشان يطلع نص عادي.
  let v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  // Also wrap in quotes if it contains \r (before only , " and \n were checked).
  // نحطه بين علامتين تنصيص إذا فيه \r بعد (قبل كان يشيّك , " و \n بس).
  if (v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\r")) {
    v = `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/** Builds the CSV body for `GET /v1/transactions/export`. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const result = await pool.query<TransactionRow>(
    `SELECT * FROM transactions
      WHERE merchant_id = $1
        AND ($2::timestamptz IS NULL OR occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR occurred_at <  $3)
        AND ($4::text[] IS NULL OR status = ANY($4))
      ORDER BY occurred_at ASC`,
    [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray],
  );

  const header = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
  const lines = result.rows.map(toCsvRow);
  return [header, ...lines].join("\n");
}


export const EXPORT_CSV_HEADER = "id,status,amount_bhd,captured_bhd,reference,occurred_at";

/**
 * Streams the export page by page (keyset on (occurred_at, id)), so memory
 * stays flat however large the merchant. This is what
 * `GET /v1/transactions/export` now serves.
 *
 * Fixed: the route used buildTransactionsExportCsv, which loads every row
 * and the whole CSV string into memory (the CHANGELOG's "streams rows" was
 * not true) — a large merchant's export could exhaust the 512 MB API
 * container. The earlier streaming draft paged on occurred_at alone with a
 * strict `>`, which silently skipped rows sharing a timestamp at a page
 * boundary; the cursor now includes id as a tie-breaker.
 *
 * Fix 3.7 / إصلاح 3.7: الرابط كان يحمّل "كل" العمليات والملف كامل في
 * الذاكرة مرة وحدة (والـ CHANGELOG يقول "streams rows" وهذا مو صحيح)، فتاجر
 * كبير يقدر يملأ ذاكرة السيرفر (2 جيجا عندنا!) ويطيّحه. الحين نرسل الملف
 * صفحة صفحة (1000 عملية كل مرة)، فالذاكرة تظل ثابتة مهما كبر التاجر.
 * وصلحنا بعد: النسخة القديمة من البث كانت تتخطى عمليات لها نفس الوقت بالضبط
 * عند حدود الصفحة؛ الحين نرتب بالوقت + الـ id.
 */
export async function* streamTransactionsExportCsvChunks(
  pool: Pool,
  filters: TransactionsExportFilters,
  pageSize = 1000,
): AsyncGenerator<string> {
  yield `${EXPORT_CSV_HEADER}\n`;
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAt: Date; id: string } | null = null;

  while (true) {
    const result: { rows: TransactionRow[] } = await pool.query<TransactionRow>(
      `SELECT * FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        pageSize,
      ],
    );
    if (result.rows.length > 0) {
      yield result.rows.map((row) => `${toCsvRow(row)}\n`).join("");
    }
    if (result.rows.length < pageSize) return;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.occurred_at, id: last.id };
  }
}