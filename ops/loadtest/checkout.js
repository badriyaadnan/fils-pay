// Capacity test: the checkout flow (k6). / اختبار الضغط: خطوات الدفع (k6).
//
// Each virtual user = one shopper: the merchant creates a payment link (API
// key), the shopper opens it, then pays with a test card. Then 1 s pause.
// كل مستخدم وهمي = زبون: التاجر يسوي رابط دفع (بمفتاح API)، الزبون يفتحه،
// وبعدين يدفع ببطاقة تجريبية، وبعدها ينتظر ثانية.
//
// Load goes up in steps (5 → 10 → 20 → 40 → 80 users, 30 s each), and the
// summary prints latency and success per step, so we can see where it breaks.
// الضغط يزيد على مراحل، والملخص يطلع السرعة والنجاح لكل مرحلة،
// فنشوف عند أي عدد يبدأ يتعب.
//
// Run (PowerShell) / التشغيل:
//   Get-Content loadtest/checkout.js | docker run --rm -i -e BASE=http://139.59.64.139:3000 -e KEY=fp_live_... -e MID=<merchant id> grafana/k6 run -
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE || "http://139.59.64.139:3000";
const KEY = __ENV.KEY;
const MID = __ENV.MID || "9972daab-2c86-459f-9d78-3fe1be4e3280"; // Alpha Retail Co

const LEVELS = [5, 10, 20, 40, 80];
const STEP_SECONDS = 30;
const GAP_SECONDS = 5;

const scenarios = {};
const thresholds = {};
LEVELS.forEach((vus, i) => {
  scenarios[`users_${vus}`] = {
    executor: "constant-vus",
    vus,
    duration: `${STEP_SECONDS}s`,
    startTime: `${i * (STEP_SECONDS + GAP_SECONDS)}s`,
    tags: { users: String(vus) },
  };
  // Not pass/fail rules, just so the summary shows each step separately.
  // مو شروط نجاح، بس عشان الملخص يطلع كل مرحلة بروحها.
  thresholds[`checkout_ok{users:${vus}}`] = ["rate>=0"];
  thresholds[`checkout_ms{users:${vus}}`] = ["p(95)>=0"];
  thresholds[`shed_503{users:${vus}}`] = ["count>=0"];
  thresholds[`checkouts_done{users:${vus}}`] = ["count>=0"];
});

export const options = { scenarios, thresholds, summaryTrendStats: ["avg", "med", "p(95)", "max"] };

const checkoutOk = new Rate("checkout_ok");        // paid successfully / الدفع نجح
const checkoutMs = new Trend("checkout_ms", true); // view + pay time / وقت الفتح + الدفع
const shed = new Counter("shed_503");              // turned away by load shedding / انرفض بـ 503
const done = new Counter("checkouts_done");        // completed checkouts / عمليات دفع خلصت

export default function () {
  const ref = `load-${__VU}-${__ITER}-${Date.now()}`;
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  const created = http.post(
    `${BASE}/v1/merchants/${MID}/payment-links`,
    JSON.stringify({ amountFils: 5000, reference: ref, description: "load test", expiresAt }),
    { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, tags: { step: "create" } },
  );
  if (created.status === 503) shed.add(1);
  if (created.status !== 201) {
    checkoutOk.add(false);
    sleep(1);
    return;
  }
  const token = created.json("token");

  const start = Date.now();
  const view = http.get(`${BASE}/v1/payment-links/${token}`, { tags: { step: "view" } });
  if (view.status === 503) shed.add(1);
  const paid = http.post(
    `${BASE}/v1/payment-links/${token}/pay`,
    JSON.stringify({ card: { pan: "4111111111111111", expiryMonth: 12, expiryYear: 2030, cvv: "123" } }),
    { headers: { "Content-Type": "application/json", "Idempotency-Key": `pay-${ref}` }, tags: { step: "pay" } },
  );
  checkoutMs.add(Date.now() - start);
  if (paid.status === 503) shed.add(1);

  // The simulated acquirer declines (402) or errors (502) ~2% of cards by design
  // (ACQUIRER_FAILURE_RATE). Those are correct answers, not server failures.
  // البنك التجريبي يرفض (402) أو يرجع خطأ (502) تقريباً 2% عن قصد، وهذي أجوبة صحيحة مو عطل.
  const ok = check(paid, {
    "paid or acquirer answer (correct)": (r) => r.status === 200 || r.status === 402 || r.status === 502,
  });
  checkoutOk.add(ok);
  if (ok) done.add(1);
  sleep(1);
}