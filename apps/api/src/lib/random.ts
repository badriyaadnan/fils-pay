import { randomInt } from "node:crypto";

// Fix 1.2: everything made here can become a secret (OTP codes, payment-link
// tokens, admin invite codes). Math.random() is NOT secure: someone who sees
// a few outputs can predict the next ones. crypto.randomInt uses the
// operating system's secure random generator, so the values can't be guessed.
// إصلاح 1.2: كل شي يتولّد هني ممكن يصير سر (كود OTP، رابط دفع، كود دعوة أدمن).
// Math.random() مو آمن: اللي يشوف كم نتيجة يقدر يتوقع اللي بعدها.
// crypto.randomInt يستخدم مولّد الأرقام الآمن في نظام التشغيل، فما ينخمّن.

/** Generates a string of `n` random decimal digits (e.g. "042817"). */
export function randomDigits(n: number): string {
  // One secure digit at a time (0-9).
  // نطلع رقم آمن وحدة وحدة (من 0 إلى 9).
  let out = "";
  for (let i = 0; i < n; i++) {
    out += String(randomInt(10));
  }
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    // Was: Math.floor(Math.random() * alphabet.length)
    // كان: Math.floor(Math.random() * alphabet.length)
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}