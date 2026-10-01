import { test } from "node:test";
import assert from "node:assert/strict";
import { camelName, toolName, unitKey } from "./names.ts";

test("camelName uppercases each segment after the first", () => {
  assert.equal(camelName("ping"), "ping");
  assert.equal(camelName("read-url"), "readUrl");
  assert.equal(camelName("save-2fa"), "save2fa");
  assert.equal(camelName("a-b-c"), "aBC");
});

test("unitKey derives each kind's map key from the kebab basename", () => {
  assert.equal(unitKey("rpc", "quick-list"), "quickList");
  assert.equal(unitKey("command", "quick-list"), "quick-list");
  assert.equal(unitKey("tools", "quick-list"), "quick_list");
});

test("toolName prefixes the underscored plugin id", () => {
  assert.equal(toolName("my-plugin", "list_items"), "my_plugin_list_items");
});
