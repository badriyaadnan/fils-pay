# FilsPay — audit fixes (The Handover)

Each entry: **what** was wrong, **why** it happened, **what it broke**, and
the **fix** (smallest change that works). Numbers match the team's task list.

---

## 0. The stack did not boot

**0.1 Dockerfiles missing** — `ops/docker-compose.yml` builds from
`ops/Dockerfile.node` / `ops/Dockerfile.go`, which were not in the repo.
*Breaks:* `docker compose up` fails immediately. *Fix:* added both (node 20
workspace install; static Go build on alpine with embedded tzdata).

**0.2 Migrations 0054 and 0055 fail on a fresh database** — 0054 referenced a
table that never existed (`settlement_batch_events`); 0055 inserted into
columns `chart_of_accounts` does not have. *Breaks:* `migrate` stops at 0054,
so no service can start. *Fix:* 0054 uses `te.settlement_batch_id IS NULL`;
0055 uses the real columns `(id, name, kind)`. (They could never have applied
anywhere, so editing them is safe.)

**0.3 Service settings never loaded** — `.env.docker` was described as
"loaded for every service" but compose had no `env_file:`; the api requires
`SETTLEMENT_INTERNAL_TOKEN` etc. *Fix:* `env_file: .env.docker` on api,
settlement, reporting; local-only values; services wait for `migrate`.
The previously committed acquirer secret must be treated as leaked.

---

## 1. Security

**1.1 Login without OTP** (`auth/sessions.ts`) — `lookupSession` read
`live_sessions` by token only; it never required `authenticated = true`
(0012's own rule). *Breaks:* the cookie set after the password step was a
full login; OTP did nothing. *Fix:* `AND s.authenticated = true`.

**1.2 Predictable secrets** (`lib/random.ts`, `admin/inviteCode.ts`) — OTP
codes, payment-link tokens and admin invite codes came from `Math.random`,
whose output is predictable from earlier outputs. *Fix:* `crypto.randomInt`.

**1.3 OTP brute force by parallel requests** (`routes/auth.ts`,
`routes/adminAuth.ts`) — read `attempt_count`, compare, then increment:
50 parallel guesses all read 0. *Fix:* spend the attempt first with one
conditional `UPDATE … WHERE attempt_count < max_attempts RETURNING`.

**1.4 OTP sent to the wrong account** (`routes/auth.ts`) — after verifying
the password for (merchant, email), the code looked the user up again by
email only across all merchants. *Breaks:* log in to merchant A, land in
merchant B with the same email. *Fix:* use the verified user.

**1.5 Cancel another merchant's payment link** (`paymentLinks/cancel.ts`) —
the route checked the path merchant, the UPDATE matched the link id only.
*Fix:* `AND merchant_id = $2`.

**1.6 Impersonation was not read-only; support could move money**
(`admin/impersonation.ts`, `routes/transactions.ts`) — super_admin mapped to
`owner`, finance to `finance`; capture/void had no role check at all.
*Breaks:* operators (and support-role users) could capture, void, create keys
and refunds, recorded as the merchant. *Fix:* every admin maps to `support`;
capture/void require owner/finance.

**1.7 Self-approval of credits** (`admin/creditApproval.ts`) — two-person
control compared display names. *Fix:* compare `adminUserId`.

**1.8 Forged acquirer callbacks** (`webhooks/inboundVerify.ts`) — the only
authentication of a public route, and a missing header meant "valid"
(`requireSignature` default false); no replay window; `Buffer.compare` is not
constant-time; `outcome` never validated. *Fix:* signature required by
default, ±300 s window, `timingSafeEqual`, outcome whitelist.

**1.9 Paying an expired link** (`paymentLinks/pay.ts`, FP-187) — expiry was
judged against `submittedAt` from the browser. *Fix:* server clock only.

**1.10 Key rotation kept the old key alive** (`admin/apiKeys.ts`) — nothing
set `revoked_at`. *Fix:* revoke in the same transaction.

**1.11 SSRF through webhooks** (`webhooks/create.ts`, `transport.ts`) —
"https only" accepted `https://169.254.169.254/…` and internal hosts, and
fetch followed redirects. *Fix:* in production refuse loopback/private/
link-local/single-label hosts; `redirect: "manual"`.

**1.12 CSV formula injection** (`transactions/exportCsv.ts`) — a reference
like `=HYPERLINK(…)` ran when finance opened the export. *Fix:* prefix `'`.

---

## 2. Money

**2.1 CSV import 10× too small** (`admin/adjustmentCsvParsing.ts`) — parsed
with two decimals ("cents"): `4.75` → 475 fils, `4.755` → truncated.
1 BD = 1000 fils (ADR-0001). *Fix:* `parseBhdToFils`. The test that asserted
475 is corrected (commit 9567ea0: "the test is wrong, but the test is
scripture").

**2.2 Net payout in float32** (`settlement/payable.go`) — gross/fee converted
to BD in float32 (~7 digits) and back. *Breaks:* every batch above
~16,777 BD paid the wrong amount. *Fix:* `gross - fee` in integer fils.

**2.3 "Rebuild cached balances" destroyed balances** (`internalapi/server.go`,
0054, FP-203) — the button read a view summing gross scheme lines (no fees,
payouts or refunds): 135K → 7K. *Fix:* rebuild from the ledger, like the CLI;
the view now reads the ledger too.

**2.4 Scheme statement "always over, never under"** (`settlement/batch.go`)
— `amount` was `float64(gross)/1000` rounded by Postgres to 2 dp, while
`amount_fils` was truncated. *Fix:* `amount` = truncated fils formatted to
2 dp (ADR-0002).

**2.5 Rounding residue never journaled** (`settlement/batch.go`) — ADR-0002
("implemented in March") was never implemented. *Fix:* per line, credit
`card_scheme_clearing`, debit `scheme_rounding_residue`.

**2.6 Split payouts lose fils** (`splits/`) — each child rounded on its own.
*Fix:* largest-remainder allocation; shares sum to the net exactly.

**2.7 MDR recalculation rewrote paid batches** (`recalculate_mdr.go`) —
selected `status <> 'open'` and updated fee/net. *Fix:* paid batches are
never changed; only the ledger adjustment is posted.

**2.8 Daily close at 03:15 instead of 00:15** (`scheduler/daemon.go`) —
"today" was taken from the UTC date. *Fix:* `BusinessDateOf` (Bahrain date).

**2.9 Volume counter overflow** (`platform_volume.go`, 0049) — `int32` /
`INTEGER` (max ~2.15M BD), tier at 2M BD. *Fix:* int64 / BIGINT (0074).

**2.10 Lifetime payout estimate drift** — float32 / REAL. *Fix:* BIGINT.

**2.11 Dashboard fee 245 bps, charged 225** (`currentFeeScheduleDisplay.ts`)
— showed the last row *entered*, not the one *in effect*. *Fix:* newest
`effective_from <= now()`.

**2.12 Discount applied two different ways** (`payments/capture.ts`) — capture
charged full MDR, then (only on the /v1/transactions route, in a separate
transaction) rebated fee × discount; payment-link captures got no discount;
settlement computed MDR on the discounted amount. *Fix:* capture uses the
settlement formula.

**2.13 Nightly job could delete every hold** (`scripts/expire_holds.ts`) — an
empty id list produced `DELETE FROM holds`. Holds are never to be deleted.
*Fix:* one `UPDATE … SET status = 'expired'`; `buildDelete` refuses an empty
WHERE.

**2.14 March sweep** (`scripts/reconcile_march.ts`) — UTC month; it *debited
merchants* for the residue (ADR-0002 says clearing/suspense); not rerun-safe
("ran twice on staging"). *Fix:* Bahrain month, ADR legs, refuses to post
twice. Finance must reverse the earlier run's wrong legs explicitly.

**2.15 Settlement summary double count** (`settlement/query.ts`) — summed
`captured_fils` (running total) once per capture event. *Fix:* sum event
amounts.

**2.16 Reconciliation gaps that were estimation error** — pending fees were
re-estimated from `mdr_bps`. *Fix:* use the fee recorded at capture.

**2.17 Timeline crashed after a refund** (`web/src/format.ts`) — `bhd()`
threw on negative amounts. *Fix:* allow negatives.

**2.18 Promotional discount parsed as cents** (`payments/discountAdjustment.ts`)
— `parseFloat(x) * 100`. *Fix:* `parseBhdToFils`.

---

## 3. Duplicates and races

**3.1 Duplicate callback notes** (FP-201, reopened) — no dedupe existed.
*Fix:* unique `callback_id` (0073), `ON CONFLICT DO NOTHING`.

**3.2 Payment link charged twice** (incident 2026-05-14) — a reservation older
than the timeout could be re-claimed while the first buyer was still paying;
the first request then answered 200 anyway. *Fix:* the reservation's
`reserved_at` is a fencing token, renewed right before capture; if lost, the
authorization is voided (no money moved).

**3.3 "Your payout is on the way" twice** (incident 2026-08-21) — check-then-
insert of `settlement.paid` (daemon + CLI), and the dispatcher read due rows
without locking. *Fix:* unique index (0075) + `ON CONFLICT`; deliveries are
claimed with `FOR UPDATE SKIP LOCKED` and a lease.

**3.4 Payout instructions per webhook endpoint** — the disbursement record was
a side effect of webhook delivery: two endpoints → two, none → zero. *Fix:*
written in PayoutBatch's transaction, unique per batch.

**3.5 Merchants could not verify webhooks** (FP-240) — signed
`canonicalJson(payload)`, sent `JSON.stringify(payload)` (jsonb key order).
*Fix:* sign exactly the bytes sent (Yousif's `ya/sign-raw`).

**3.6 Merchant logged out after 10 minutes** — the cookie kept the pending
session's maxAge. *Fix:* re-set it at OTP verify (as admin does).

**3.7 Export out of memory / skipped rows** — the route built the whole CSV in
memory (512 MB container); the paging draft skipped equal timestamps.
*Fix:* streamed, keyset on `(occurred_at, id)`.

**3.8 Slow analytics query** — `AT TIME ZONE … ::date` on the column
prevented index use. *Fix:* the same Bahrain range on raw `occurred_at`.

---

## 4. Missing feature: refunds (FP-212 / FP-300)

`POST /v1/refunds` returned 501. Now:

- Routes: `POST /v1/refunds` and `POST /v1/merchants/:merchantId/refunds`
  (owner/finance or API key), `Idempotency-Key` required.
- `processRefund` in **one** transaction holding the row lock across the
  acquirer call (FP-209: two concurrent refunds could both pass).
- Refundable = **captured** − refunded (was authorized − refunded).
- Scoped by merchant (any merchant could refund any transaction).
- Fee reversal is cumulative: partial refunds return exactly the fee charged.
- `reason` defaults to `'unspecified'` (0070's check rejected NULL).
- Settlement: CloseBatch claims unbatched refunds and deducts
  `amount − fee reversed` from the next payout; rolls forward if the day
  cannot cover it.
- Webhook `refund.succeeded` (envelope + eligible list).
- Reporting: refund columns added (0076; the consumer already wrote them and
  would have crashed), refund summary view fixed (joined `t.id = r.id`),
  Bahrain date.
- Dashboard: drawer restored (BD input, refundable ceiling, stable
  idempotency key on retry), refunded amount shown, timeline handles negatives.

---

## 5. Tests

All suites pass: api 377/377, reporting 11/11, web 8/8, scripts 6/6,
money 40/40, events 4/4, and every Go package (`go test -p 1 ./...`).

Tests were changed **only** where they asserted a bug we fixed, each with a
comment explaining why:

- `admin/adjustmentImport.test.ts`, `routes/adminAdjustmentImport.test.ts`,
  `admin/adjustmentCsvParsing.test.ts` — expected the 10× too small amounts
  (350, 500, 600 …). Now 3500, 5000, 6000 (2.1).
- `routes/admin.test.ts` — expected a rotated key to keep working. Now 401 and
  `revoked_reason = 'rotated'` (1.10; the audit log already said
  `revokedKeyId`).
- `webhooks/dispatcher.test.ts` — compared a randomly jittered backoff to an
  exact 1000 ms (passed ~0.5% of runs). Now passes a fixed jitter.
- `ledger/refresh_test.go` — expected balance = sum of scheme lines (2.3).
  Now posts the ledger credit, plus a test that export lines alone don't count.
- Tests for 1.8, 1.9, 2.6–2.11, 2.13, 2.14, 3.1, 3.5 and refunds were updated
  or added alongside each fix.

Notes: `npm test` uses a quoted glob that only Node 21+ expands (our image is
Node 20), so we ran each workspace with `find`. Reporting tests must run on a
fresh test database: `archiveReplay.test.ts` inserts `transaction.captured`
outbox rows with an empty payload, which the reporting consumer then reads.

---

## 6. Deployment (Dilmune server `AK`)

One 2 GB / 1 vCPU machine runs the whole stack with `docker compose`.
`restart: unless-stopped` on every long-running service; Postgres is bound to
`127.0.0.1` only; the dashboard is served on port 5173 and proxies `/v1` to
the API on 3000; the firewall allows only 22, 3000 and 5173.

---

## 7. Found, not fixed (needs a decision or a larger change)

- Reporting consumer advances by outbox id; a lower id committed later is
  skipped forever (needs a commit-order cursor, xid8).
- "Adjust balance" writes the cache only (ADR-0006); a rebuild erases it.
- Volume-tier threshold changed without finance sign-off (d69a813).
- Historical scheme lines and the earlier March sweep need finance-approved
  correcting entries.
- Webhook SSRF via DNS rebinding (needs resolve-and-pin).
- A capture whose reservation expires mid-capture now answers 409 and logs
  "REFUND REQUIRED" (should become an automatic refund).
- `PGCONN_SETTLEMENT` overrides `DATABASE_URL` (docs say the opposite).

## 8. The case

The repo's AI-instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`)
were planted with false rules that reproduce these bugs; they are replaced.
Git history (three "transmissions": Base64 → Vigenère key `diffs` → ROT13
ledger notes → AES key `2026-09-28`, the date of the commit made under
Yousif's name after his account was deleted) gives:
`FLAG{order_of_the_prompt_never_read_the_diff}`.