import { test } from "node:test";
import assert from "node:assert/strict";
import { UNIT_NAME_PATTERN, camelName } from "./bin-shared.ts";

test("camelName follows the camelization pin (§3)", () => {
  assert.equal(camelName("ping"), "ping");
  assert.equal(camelName("read-url"), "readUrl");
  assert.equal(camelName("save-2fa"), "save2fa");
  assert.equal(camelName("a-b-c"), "aBC");
});

test("UNIT_NAME_PATTERN accepts kebab-case and rejects the rest", () => {
  assert.ok(UNIT_NAME_PATTERN.test("ping"));
  assert.ok(UNIT_NAME_PATTERN.test("read-url"));
  assert.ok(UNIT_NAME_PATTERN.test("save-2fa"));
  assert.ok(!UNIT_NAME_PATTERN.test(""));
  assert.ok(!UNIT_NAME_PATTERN.test("2fa"));
  assert.ok(!UNIT_NAME_PATTERN.test("readUrl"));
  assert.ok(!UNIT_NAME_PATTERN.test("read_url"));
  assert.ok(!UNIT_NAME_PATTERN.test("Read-url"));
});
