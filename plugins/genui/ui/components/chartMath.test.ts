import { describe, expect, it } from "vitest";
import {
  countTicks,
  dialPoint,
  formatShare,
  funnelStages,
  heatLevel,
  intensity,
  nearestPoint,
  niceScale,
  numericValue,
  percentages,
  pieSlices,
  radarPoint,
  scatterPoints,
  stackSeries,
  stepGrid,
  trendLabel,
  valueRange,
} from "./chartMath";

describe("stackSeries", () => {
  it("piles each label's values in series order", () => {
    const [a, b] = stackSeries([
      [1, 2],
      [3, 4],
    ]);
    expect(a).toEqual([
      { from: 0, to: 1, outer: false },
      { from: 0, to: 2, outer: false },
    ]);
    expect(b).toEqual([
      { from: 1, to: 4, outer: true },
      { from: 2, to: 6, outer: true },
    ]);
  });

  it("stacks negatives down from zero, separately from positives", () => {
    const [a, b, c] = stackSeries([[5], [-2], [-3]]);
    expect(a![0]).toEqual({ from: 0, to: 5, outer: true });
    expect(b![0]).toEqual({ from: 0, to: -2, outer: false });
    expect(c![0]).toEqual({ from: -2, to: -5, outer: true });
  });

  it("leaves gaps for missing values and stacks the rest over what is there", () => {
    const [a, b, c] = stackSeries([[1, 1], [null, 2], [4]]);
    expect(b![0]).toBeNull();
    expect(c![0]).toEqual({ from: 1, to: 5, outer: true });
    // Shorter series are padded with gaps; a trailing zero never takes the rounded top.
    expect(c![1]).toBeNull();
    expect(stackSeries([[3], [0]])[0]![0]!.outer).toBe(true);
    expect(a).toHaveLength(2);
  });
});

describe("pieSlices", () => {
  it("drops zero, negative and missing values and names unlabeled slices", () => {
    expect(pieSlices(["a", "b", "c", "d"], [3, 0, -1, null, 2])).toEqual([
      { label: "a", value: 3, source: 0 },
      { label: "Item 5", value: 2, source: 4 },
    ]);
  });

  it("folds the smallest past eight slices into a trailing Other, keeping data order", () => {
    const values = [5, 1, 9, 2, 8, 3, 7, 4, 6, 0.5];
    const slices = pieSlices(values.map((_, index) => `s${index}`), values);
    expect(slices).toHaveLength(8);
    expect(slices.map((slice) => slice.label)).toEqual(["s0", "s2", "s4", "s5", "s6", "s7", "s8", "Other"]);
    expect(slices[7]).toEqual({ label: "Other", value: 3.5, source: -1 });
  });

  it("keeps exactly eight slices unfolded", () => {
    expect(pieSlices([], [1, 2, 3, 4, 5, 6, 7, 8]).some((slice) => slice.source === -1)).toBe(false);
  });
});

describe("percentages", () => {
  it("always sums to 100", () => {
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentages([1, 2, 3, 4, 5, 6, 7])).toEqual([4, 7, 11, 14, 18, 21, 25]);
    expect(percentages([1000, 1, 1]).reduce((sum, share) => sum + share, 0)).toBe(100);
  });

  it("gives the spare points to the largest remainders", () => {
    expect(percentages([0.5, 0.5, 99])).toEqual([1, 0, 99]);
  });

  it("is all zeros without a positive total", () => {
    expect(percentages([])).toEqual([]);
    expect(percentages([0, 0])).toEqual([0, 0]);
  });
});

describe("trendLabel", () => {
  it("summarizes first to last with direction and change", () => {
    expect(trendLabel([12, 30, 18])).toBe("Trend from 12 to 18, up 50%");
    expect(trendLabel([1200, 900])).toBe("Trend from 1,200 to 900, down 25%");
    expect(trendLabel([4, 9, 4])).toBe("Trend from 4 to 4, flat");
    expect(trendLabel([0, 3])).toBe("Trend from 0 to 3, up");
    expect(trendLabel([7])).toBe("No trend");
  });
});

describe("niceScale", () => {
  it("covers the data in readable steps, both ends on a tick", () => {
    expect(niceScale(3, 97)).toEqual({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(-12, 30).ticks).toEqual([-20, 0, 20, 40]);
  });

  it("leaves zero out unless asked, and keeps decimal ticks free of float noise", () => {
    expect(niceScale(1.1, 1.9)).toEqual({ min: 1, max: 2, ticks: [1, 1.2, 1.4, 1.6, 1.8, 2] });
    expect(niceScale(1.1, 1.9, 4, true).min).toBe(0);
    expect(niceScale(0.1, 0.3, 2).ticks).toEqual([0.1, 0.2, 0.3]);
  });

  it("gives a single value a step of room instead of a zero-height axis", () => {
    const scale = niceScale(5, 5);
    expect(scale.max).toBeGreaterThan(scale.min);
    expect(scale.min).toBeLessThanOrEqual(5);
    expect(scale.max).toBeGreaterThanOrEqual(5);
    expect(niceScale(0, 0).ticks).toEqual([0, 0.25]);
  });
});

describe("countTicks", () => {
  it("counts in whole steps from zero, never 2.5 or fractions", () => {
    expect(countTicks(10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(countTicks(17)).toEqual([0, 5, 10, 15, 20]);
    expect(countTicks(1)).toEqual([0, 1]);
    expect(countTicks(0)).toEqual([0, 1]);
  });
});

describe("numericValue", () => {
  it("reads numbers and strings that are exactly a number", () => {
    expect(numericValue(4)).toBe(4);
    expect(numericValue(" 2.5 ")).toBe(2.5);
    expect(numericValue("-3e2")).toBe(-300);
  });

  it("rejects everything else, including empty strings Number() would make 0", () => {
    expect(numericValue("")).toBeNull();
    expect(numericValue("  ")).toBeNull();
    expect(numericValue("12px")).toBeNull();
    expect(numericValue(Infinity)).toBeNull();
    expect(numericValue(null)).toBeNull();
    expect(numericValue(true)).toBeNull();
  });
});

describe("formatShare", () => {
  it("keeps a decimal under 10% and rounds above", () => {
    expect(formatShare(0.4213)).toBe("42%");
    expect(formatShare(0.042)).toBe("4.2%");
    expect(formatShare(0.05)).toBe("5%");
    expect(formatShare(1.5)).toBe("150%");
  });

  it("never shows a non-zero sliver as 0%", () => {
    expect(formatShare(0.0004)).toBe("<0.1%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(Number.NaN)).toBe("—");
  });
});

describe("scatterPoints", () => {
  it("pairs x with each series' y, skipping gaps, ordered by x then series", () => {
    expect(scatterPoints([3, null, 1], [[30, 20, 10], [null, 5, 11]])).toEqual([
      { series: 0, index: 2, x: 1, y: 10 },
      { series: 1, index: 2, x: 1, y: 11 },
      { series: 0, index: 0, x: 3, y: 30 },
    ]);
  });
});

describe("nearestPoint", () => {
  it("finds the closest point within the radius", () => {
    const points: [number, number][] = [[0, 0], [10, 0], [10, 10]];
    expect(nearestPoint(points, 9, 2, 20)).toBe(1);
    expect(nearestPoint(points, 9, 9, 20)).toBe(2);
  });

  it("is null when nothing is within reach", () => {
    expect(nearestPoint([[0, 0]], 30, 0, 20)).toBeNull();
    expect(nearestPoint([], 0, 0, 20)).toBeNull();
  });
});

describe("radarPoint", () => {
  it("puts the first axis straight up and turns clockwise", () => {
    const [x0, y0] = radarPoint(100, 100, 50, 0, 4, 1);
    const [x1, y1] = radarPoint(100, 100, 50, 1, 4, 1);
    expect([x0, y0]).toEqual([100, 50]);
    expect(x1).toBeCloseTo(150);
    expect(y1).toBeCloseTo(100);
  });

  it("scales by the ratio toward the centre", () => {
    const [x, y] = radarPoint(0, 0, 80, 2, 4, 0.5);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(40);
  });
});

describe("funnelStages", () => {
  it("sizes bars by the widest stage and reports conversion from the first and the previous", () => {
    const stages = funnelStages(["Visits", "Sign-ups", "Paid"], [1000, 400, 100]);
    expect(stages.map((stage) => stage.width)).toEqual([1, 0.4, 0.1]);
    expect(stages.map((stage) => stage.ofFirst)).toEqual([1, 0.4, 0.1]);
    expect(stages.map((stage) => stage.ofPrevious)).toEqual([null, 0.4, 0.25]);
  });

  it("leaves out stages whose value has not arrived and names unlabeled ones", () => {
    const stages = funnelStages(["A", "B", "C"], [10, null]);
    expect(stages.map((stage) => stage.label)).toEqual(["A"]);
    expect(funnelStages([], [5])[0]!.label).toBe("Stage 1");
  });

  it("has no ratio against a zero stage", () => {
    const stages = funnelStages(["A", "B", "C"], [0, 0, 0]);
    expect(stages.map((stage) => [stage.width, stage.ofFirst, stage.ofPrevious])).toEqual([
      [0, null, null],
      [0, null, null],
      [0, null, null],
    ]);
  });
});

describe("intensity and heatLevel", () => {
  it("places a value between min and max, clamped", () => {
    expect(intensity(5, 0, 10)).toBe(0.5);
    expect(intensity(-5, 0, 10)).toBe(0);
    expect(intensity(15, 0, 10)).toBe(1);
    expect(intensity(3, 3, 3)).toBe(1);
  });

  it("shades counts in levels, with nothing at level 0", () => {
    expect([0, -2, 1, 25, 26, 100].map((value) => heatLevel(value, 100))).toEqual([0, 0, 1, 1, 2, 4]);
    expect(heatLevel(5, 0)).toBe(0);
  });

  it("finds the finite range", () => {
    expect(valueRange([3, null, -1, 8])).toEqual({ min: -1, max: 8 });
    expect(valueRange([null])).toBeNull();
  });
});

describe("dialPoint", () => {
  it("runs from the left end through the top to the right", () => {
    const [lx, ly] = dialPoint(50, 50, 40, 0);
    const [tx, ty] = dialPoint(50, 50, 40, 0.5);
    const [rx, ry] = dialPoint(50, 50, 40, 1);
    expect(lx).toBeCloseTo(10);
    expect(ly).toBeCloseTo(50);
    expect(tx).toBeCloseTo(50);
    expect(ty).toBeCloseTo(10);
    expect(rx).toBeCloseTo(90);
    expect(ry).toBeCloseTo(50);
  });
});

describe("stepGrid", () => {
  it("moves by arrow keys and stops at the edges", () => {
    expect(stepGrid("ArrowRight", 0, 0, 2, 3)).toEqual([0, 1]);
    expect(stepGrid("ArrowLeft", 0, 0, 2, 3)).toEqual([0, 0]);
    expect(stepGrid("ArrowDown", 1, 2, 2, 3)).toEqual([1, 2]);
    expect(stepGrid("ArrowUp", 1, 2, 2, 3)).toEqual([0, 2]);
    expect(stepGrid("End", 1, 0, 2, 3)).toEqual([1, 2]);
    expect(stepGrid("Home", 1, 2, 2, 3)).toEqual([1, 0]);
    expect(stepGrid("Enter", 0, 0, 2, 3)).toBeNull();
  });
});
