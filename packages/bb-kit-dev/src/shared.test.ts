import { test } from "node:test";
import assert from "node:assert/strict";
import { UNIT_NAME_PATTERN, relativeImport } from "./shared.ts";

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

test("relativeImport omits TypeScript extensions", () => {
  assert.equal(relativeImport("src/server/server.ts", "src/server/rpc/ping.ts"), "./rpc/ping");
  assert.equal(relativeImport("src/app/rpc.ts", "src/server/server.ts"), "../server/server");
});
