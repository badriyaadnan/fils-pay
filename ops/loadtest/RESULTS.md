# Load test results — server AK (1 vCPU / 2 GB, API capped at 0.5 vCPU / 512 MB)
# نتائج اختبار الضغط — السيرفر AK

Scenario (`checkout.js`): create payment link → open it → pay with a test card,
then 1 s think time. Steps of 5, 10, 20, 40, 80 concurrent users, 30 s each,
run from a laptop in Bahrain over the internet. Raw k6 output: `results/run-*.txt`.

## Our capacity estimate / تقديرنا

**About 30 concurrent checkout users ≈ 13 completed checkouts per second
(~780 per minute), with 100% correct answers and p95 checkout time ≈ 2 s.**
Above that, the excess is turned away immediately with `503` + `Retry-After: 1`
(no work done, no data touched), and the checkouts we accept stay at p95 ≈ 2 s.
The limit is the API's 0.5 vCPU (measured: api CPU at ~46–50% of the host
= its full quota, memory ~90 MB of 512 MB).

## Runs / التجارب

| Run | PG pool | Max in flight | Max checkouts/s | p95 @ 20 users | p95 @ 80 users | Result |
|---|---|---|---|---|---|---|
| 1 | 5 | 32 | ~9 | 2.48 s | 3.69 s | ok, sheds from 40 users |
| 2 | 20 | 48 | ~11 | 4.18 s | **19 s** | worse: more concurrency only slowed everyone down |
| 3 (final) | 10 | 24 | **~13** | 2.68 s | **2.14 s** | best: flat latency, sheds the excess |

Run 3 per step:

| Users | Correct | Checkouts (30 s) | ≈ per s | p95 checkout | 503 shed |
|---|---|---|---|---|---|
| 5 | 100% | 55 | 1.8 | 2.08 s | 0 |
| 10 | 100% | 116 | 3.9 | 2.10 s | 0 |
| 20 | 100% | 236 | 7.9 | 2.68 s | 0 |
| 40 | 80.8% | 387 | 12.9 | 1.98 s | 115 |
| 80 | 32.0% | 399 | 13.3 | 2.14 s | 1132 |

"Correct" counts 200 paid, and 402/502 from the simulated acquirer, which
declines/errors ~2% of cards by design (`ACQUIRER_FAILURE_RATE`). Nothing else
failed: every non-success was a deliberate 503.

## What we learned / شنو تعلمنا

- Throughput was flat at ~9/s in run 1. The first guess (DB pool too small,
  CPU idle) was **not measured** and run 2 proved it wrong.
- `docker stats` during run 3 showed the api at its CPU quota and far below
  its memory limit: CPU is the ceiling.
- So the right move is to admit only what 0.5 vCPU can finish quickly and
  reject the rest fast (load shedding), not to let more work in.