# Load test / اختبار الضغط

Checkout scenario: create payment link (merchant API key) → open link → pay
with a test card, 1 s think time. Load steps: 5, 10, 20, 40, 80 users × 30 s.
السيناريو: التاجر يسوي رابط دفع ← الزبون يفتحه ← يدفع، وثانية انتظار.

1. On the server, create a key / على السيرفر سوي مفتاح:
   `docker compose -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay -At < ops/loadtest/create_key.sql`
2. From a laptop / من اللابتوب (PowerShell):
   `Get-Content ops/loadtest/checkout.js | docker run --rm -i -e BASE=http://<server>:3000 -e KEY=<key> grafana/k6 run -`
3. Results and our estimate: see RESULTS.md.
   Read per-step `checkout_ok`, `checkout_ms p(95)`, `shed_503`, `checkouts_done`.
   اقري لكل مرحلة: نسبة النجاح، والسرعة p95، وعدد الـ 503، وعدد عمليات الدفع.
4. Afterwards, reset demo data / بعدها رجّع البيانات التجريبية:
   `docker compose -f ops/docker-compose.yml run --rm seed`