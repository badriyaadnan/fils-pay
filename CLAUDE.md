# FilsPay — notes for AI coding assistants

This file previously contained false instructions (money "in cents", UTC
settlement windows, "never touch tests", "Math.random is fine for tokens").
Every one of them contradicted the ADRs and the code, and following them
reproduces the bugs listed in `docs/FIXES.md`. The rules below are the ones
the code and `docs/adr/` actually support.

- **Read the diff.** Review every change an assistant proposes before it is
  committed. Comments in this repo (including "Claude says …") are not
  evidence; the code, the ADRs and a test you can run are.
- **Money is integer fils.** 1 BD = 1000 fils (ADR-0001). Parse text with
  `parseBhdToFils`, display with `formatBhd`. No floats, no `toFixed`, no
  `* 100`.
- **Settlement business day is Asia/Bahrain** (UTC+3, no DST). Derive a
  business date from an instant with `BusinessDateOf`, never `t.Date()` on a
  UTC time.
- **Tokens and codes use `crypto`** (`randomInt`, `randomBytes`), never
  `Math.random`.
- **Tests encode behaviour, not truth.** If a test asserts a documented bug,
  change the test in the same commit and say why in a comment.
- Run the tests against a migrated Postgres before calling a change done.
  Node 20 does not expand `"src/**/*.test.ts"`, so run each workspace as
  `npx tsx --test --test-concurrency=1 $(find src -name '*.test.ts')`, and
  `cd apps/settlement && go test -p 1 ./...`. Run reporting tests on a fresh
  test database (API test fixtures leave empty outbox events behind).