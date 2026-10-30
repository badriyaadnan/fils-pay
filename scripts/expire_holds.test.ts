import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDelete } from "./lib/sqlFilter.js";
import { EXPIRE_HOLDS_SQL } from "./expire_holds.js";

// Changed (fix 2.13): the old tests only checked the DELETE text for a
// non-empty id list. The bug was the EMPTY list, which produced
// `DELETE FROM holds`, so the tests never caught it.
// تغيّر (إصلاح 2.13): الاختبارات القديمة كانت تجرب قائمة "فيها" أرقام بس.
// والخطأ كان في القائمة "الفاضية"، فما لقته أبداً.

test("expiring holds is a conditional UPDATE, never a DELETE", () => {
  assert.match(EXPIRE_HOLDS_SQL, /^UPDATE holds SET status = 'expired'/);
  assert.match(EXPIRE_HOLDS_SQL, /WHERE status = 'active' AND expires_at < now\(\)$/);
  assert.doesNotMatch(EXPIRE_HOLDS_SQL, /DELETE/i);
});

test("buildDelete refuses to build an unfiltered DELETE (empty id list)", () => {
  assert.throws(() => buildDelete("holds", { id: [] }), /refusing to build DELETE without a WHERE/);
  assert.throws(() => buildDelete("holds", {}), /refusing to build DELETE without a WHERE/);
});

test("buildDelete still scopes a non-empty list", () => {
  const ids = ["11111111-1111-1111-1111-111111111111"];
  const { text, values } = buildDelete("holds", { id: ids });
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[])");
  assert.deepEqual(values, [ids]);
});