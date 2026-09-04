import { test } from "bun:test";
import assert from "node:assert/strict";
import { defaultStyle, isStyleName, styleNames, styles, suggestStyleName } from "./styles.ts";

test("every style has a non-empty summary", () => {
  for (const name of styleNames) {
    assert.ok(styles[name].summary.trim().length > 0, `${name} has no summary`);
  }
  assert.deepEqual(Object.keys(styles).sort(), [...styleNames].sort());
});

test("defaultStyle is a declared style", () => {
  assert.ok(isStyleName(defaultStyle));
  assert.equal(isStyleName("toString"), false);
  assert.equal(isStyleName("GitHub"), false);
});

test("suggestStyleName covers typos and abbreviations", () => {
  assert.equal(suggestStyleName("githb"), "github");
  assert.equal(suggestStyleName("gh"), "github");
  assert.equal(suggestStyleName("Default"), "default");
  assert.equal(suggestStyleName("solarized"), undefined);
});
