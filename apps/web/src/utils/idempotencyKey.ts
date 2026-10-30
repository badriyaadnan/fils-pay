// Fix 6.5: idempotency keys that also work over plain HTTP.
// إصلاح 6.5: مفاتيح منع التكرار تشتغل حتى على HTTP العادي.
//
// crypto.randomUUID() only exists in a "secure context" (HTTPS or localhost).
// On the hosted server (http://<ip>:5173) it is undefined, so the checkout
// page, the refund drawer and the capture button crashed with
// "crypto.randomUUID is not a function". crypto.getRandomValues() works in
// every context, so we build the same random (version 4) UUID from it.
// crypto.randomUUID() موجود بس في HTTPS أو localhost. على السيرفر (http + IP)
// ما يكون موجود، فصفحة الدفع وزر الاسترجاع وزر السحب كانت تطيح.
// crypto.getRandomValues() يشتغل في كل مكان، فنسوي منه نفس الـ UUID العشوائي.
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}