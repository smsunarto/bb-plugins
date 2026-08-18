import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePluginID } from "./derive-plugin-id.ts";

test("strips the npm scope", () => {
  assert.equal(derivePluginID("@get-bb/dotfiles"), "dotfiles");
});

test("strips a leading bb-plugin- prefix", () => {
  assert.equal(derivePluginID("bb-plugin-amp"), "amp");
  assert.equal(derivePluginID("@get-bb/bb-plugin-dotfiles"), "dotfiles");
});

test("prefix strip is case-sensitive and happens before lowercasing", () => {
  // "BB-plugin-Foo" does not match the case-sensitive prefix, so it
  // survives into lowercasing whole.
  assert.equal(derivePluginID("BB-plugin-Foo"), "bb-plugin-foo");
  // Mixed-case AFTER a matching prefix still lowercases.
  assert.equal(derivePluginID("bb-plugin-Foo"), "foo");
});

test("maps characters outside [a-z0-9-] to hyphens", () => {
  assert.equal(derivePluginID("my.plugin"), "my-plugin");
  assert.equal(derivePluginID("my_plugin"), "my-plugin");
});

test("trims leading and trailing hyphens", () => {
  assert.equal(derivePluginID("@scope/_name_"), "name");
});

test("errors when nothing remains", () => {
  assert.throws(() => derivePluginID("bb-plugin-"), /empty plugin id/);
  assert.throws(() => derivePluginID("@scope/---"), /empty plugin id/);
});
