import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatWhen } from "./format.ts";

test("formatWhen shows the time today and the date otherwise", () => {
  const now = new Date(2026, 8, 3, 9, 41).getTime();
  assert.equal(formatWhen(now, now), "09:41");
  assert.equal(formatWhen(new Date(2026, 7, 30, 9, 41).getTime(), now), "2026-08-30");
});
