// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PALETTE, readSeries, TONE_STROKE } from "./chartKit";

describe("readSeries", () => {
  it("colors toned series by tone and untoned ones by position", () => {
    const series = readSeries({
      Succeeded: { values: [1, 2], tone: "good" },
      Failed: { values: [0, 1], tone: "bad" },
      Other: [3, 4],
    });
    expect(series.map((s) => s.color)).toEqual([
      TONE_STROKE.good,
      TONE_STROKE.bad,
      PALETTE[2],
    ]);
    expect(series[0]!.values).toEqual([1, 2]);
  });
});
