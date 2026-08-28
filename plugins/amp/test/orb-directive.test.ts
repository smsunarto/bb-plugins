import assert from "node:assert/strict";
import { test } from "bun:test";
import { findOrbDirectiveRanges, stripOrbDirectives } from "../src/orb-directive.ts";

test("findOrbDirectiveRanges finds case-insensitive standalone tokens anywhere", () => {
  assert.deepEqual(findOrbDirectiveRanges("/orb then /ORB\nfinish /oRb"), [
    { from: 0, to: 4 },
    { from: 10, to: 14 },
    { from: 22, to: 26 },
  ]);
});

test("findOrbDirectiveRanges uses the bridge's exact whitespace boundaries", () => {
  assert.deepEqual(findOrbDirectiveRanges("/orbital (/orb) path/orb /orb,"), []);
});

test("stripOrbDirectives removes tokens without changing surrounding text", () => {
  assert.deepEqual(stripOrbDirectives("  keep\n/ORB\n  /oRb end  "), {
    text: "  keep\n\n   end  ",
    found: true,
  });
  assert.deepEqual(stripOrbDirectives("keep /orbital"), {
    text: "keep /orbital",
    found: false,
  });
});
