import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relativeTimeLabel } from "../lib/relative-time.ts";

const NOW = 1_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTimeLabel", () => {
  it("reads 'now' under a minute", () => {
    assert.equal(relativeTimeLabel(NOW - 30_000, NOW), "now");
  });

  it("steps through minutes, hours, days, and weeks", () => {
    assert.equal(relativeTimeLabel(NOW - 5 * MINUTE, NOW), "5m");
    assert.equal(relativeTimeLabel(NOW - 3 * HOUR, NOW), "3h");
    assert.equal(relativeTimeLabel(NOW - 2 * DAY, NOW), "2d");
    assert.equal(relativeTimeLabel(NOW - 20 * DAY, NOW), "2w");
  });

  it("floors rather than rounds, so a label never overstates age", () => {
    assert.equal(relativeTimeLabel(NOW - (59 * MINUTE + 59_000), NOW), "59m");
    assert.equal(
      relativeTimeLabel(NOW - (23 * HOUR + 59 * MINUTE), NOW),
      "23h",
    );
  });

  // Clocks disagree across machines, so a thread can carry a timestamp that
  // is slightly in the future. It must not read as a negative age.
  it("treats a future timestamp as 'now'", () => {
    assert.equal(relativeTimeLabel(NOW + 5 * MINUTE, NOW), "now");
  });
});
