import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { elapsedLabel } from "../lib/elapsed.ts";

describe("elapsedLabel", () => {
  it("shows whole seconds below one minute", () => {
    assert.equal(elapsedLabel(1_000, 13_999), "12s");
    assert.equal(elapsedLabel(1_000, 60_999), "59s");
  });

  it("shows whole minutes below one hour", () => {
    assert.equal(elapsedLabel(1_000, 61_000), "1m");
    assert.equal(elapsedLabel(1_000, 1_000 + 59 * 60_000 + 59_999), "59m");
  });

  it("shows whole hours without an upper cap", () => {
    assert.equal(elapsedLabel(1_000, 1_000 + 60 * 60_000), "1h");
    assert.equal(elapsedLabel(1_000, 1_000 + 49 * 60 * 60_000), "49h");
  });

  it("never shows a negative or invalid duration", () => {
    assert.equal(elapsedLabel(2_000, 1_000), "0s");
    assert.equal(elapsedLabel(Number.NaN, 1_000), "0s");
    assert.equal(elapsedLabel(1_000, Number.POSITIVE_INFINITY), "0s");
  });
});
