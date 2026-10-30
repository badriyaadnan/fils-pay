import { createHmac, timingSafeEqual } from "node:crypto";

// Fix 1.8 (summary): this endpoint is PUBLIC and the signature is its only
// protection. Before: (1) a callback with NO signature was accepted,
// (2) an old genuine callback could be replayed forever (no time check),
// (3) the compare leaked timing. All three are fixed below.
// إصلاح 1.8 (ملخص): هذا الرابط عام، والتوقيع هو الحماية الوحيدة له. قبل:
// (1) callback بدون توقيع كان ينقبل، (2) callback حقيقي قديم ينعاد إرساله
// للأبد (ما فيه فحص وقت)، (3) المقارنة تكشف معلومات من الوقت. صلحنا الثلاثة تحت.

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason =
  | "malformed_header"
  | "signature_mismatch"
  | "timestamp_out_of_tolerance";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

/** Constant-time string compare (Buffer.compare short-circuits on the
 *  first differing byte, which leaks timing). */
// (3) timingSafeEqual always takes the same time, so an attacker can't learn
// the signature byte by byte from response times.
// (3) timingSafeEqual ياخذ نفس الوقت دايماً، فالمهاجم ما يقدر يعرف التوقيع
// حرف حرف من سرعة الرد.
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Callbacks older/newer than this are rejected, so a captured genuine
 *  callback cannot be replayed later. */
// (2) 5 minutes. A callback signed more than 5 min ago (or in the future) is refused.
// (2) 5 دقايق. أي callback موقّع قبل أكثر من 5 دقايق (أو في المستقبل) ينرفض.
const CALLBACK_TOLERANCE_SECONDS = 300;

/**
 * Verifies the acquirer callback signature. This endpoint is public and the
 * signature is its ONLY authentication, so a missing header is a failure
 * unless the caller explicitly opted out (requireSignature = false, local
 * development only).
 */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  // (1) Default was false, meaning "no signature? fine". Now true, so no signature means reject.
  // (1) كان الافتراضي false يعني "ما فيه توقيع؟ عادي". الحين true، يعني بدون توقيع = رفض.
  requireSignature = true,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature
      ? { valid: false, reason: "malformed_header" }
      : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  // (2) Replay protection / حماية من إعادة الإرسال
  if (Math.abs(nowSeconds - parsed.timestamp) > CALLBACK_TOLERANCE_SECONDS) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${JSON.stringify(payload)}`)
    .digest("hex");

  if (!constantTimeEquals(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}