import { describe, expect, it } from "vitest";
import { autoEdges, boxSummary, histogram, leftOutNote, quantile, readSample } from "./distribution";

describe("quantile: Hyndman & Fan type 7 (R, NumPy, Excel QUARTILE.INC)", () => {
  it("interpolates between the closest ranks", () => {
    expect([0.25, 0.5, 0.75].map((p) => quantile([1, 2, 3, 4], p))).toEqual([1.75, 2.5, 3.25]);
    expect([0, 0.25, 0.5, 0.75, 1].map((p) => quantile([1, 2, 3, 4, 5], p))).toEqual([1, 2, 3, 4, 5]);
    expect(quantile([7], 0.25)).toBe(7);
    // No float noise: 0.1 + 0.25 × 0.1 reads 0.125.
    expect(quantile([0.1, 0.2], 0.25)).toBe(0.125);
  });
});

describe("boxSummary: Tukey whiskers at 1.5 IQR", () => {
  it("ends the whiskers at the furthest values inside the fences and keeps the rest as outliers", () => {
    // Q1 2, Q3 4, IQR 2: fences at -1 and 7.
    expect(boxSummary([1, 2, 3, 4, 100])).toEqual({ n: 5, min: 1, q1: 2, median: 3, q3: 4, max: 100, low: 1, high: 4, outliers: [100] });
    expect(boxSummary([-20, 10, 11, 12, 13, 14, 15, 16, 40])).toMatchObject({ low: 10, high: 16, outliers: [-20, 40] });
    // A value exactly on a fence is inside it.
    expect(boxSummary([1, 2, 3, 4, 7])).toMatchObject({ q1: 2, q3: 4, high: 7, outliers: [] });
  });

  it("draws one value or equal values as a flat box with no outliers, and nothing as null", () => {
    expect(boxSummary([5])).toEqual({ n: 1, min: 5, q1: 5, median: 5, q3: 5, max: 5, low: 5, high: 5, outliers: [] });
    expect(boxSummary([3, 3, 3])).toMatchObject({ q1: 3, q3: 3, low: 3, high: 3, outliers: [] });
    expect(boxSummary([])).toBeNull();
  });
});

describe("readSample", () => {
  it("keeps finite numbers ascending and counts the rest as dropped", () => {
    expect(readSample("a", [3, null, 1, Number.NaN, Infinity, "2", 2])).toEqual({ name: "a", values: [1, 2, 3], dropped: 4 });
  });

  it("says what was left out, or nothing", () => {
    expect(leftOutNote(1, 0)).toBe("1 empty or non-numeric value left out");
    expect(leftOutNote(2, 3)).toBe("2 empty or non-numeric values and 3 outside the bins left out");
    expect(leftOutNote(0, 0)).toBeNull();
  });
});

describe("autoEdges: nice bin edges", () => {
  it("takes the finer of Freedman–Diaconis and Sturges, rounded to 1, 2 or 5 × 10ⁿ at its multiples", () => {
    expect(autoEdges([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([0, 2, 4, 6, 8, 10]);
    expect(autoEdges([0.11, 0.12, 0.13, 0.2, 0.31])).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
  });

  it("gives equal values, or a single one, one bin centred on them", () => {
    expect(autoEdges([5, 5, 5])).toEqual([4.5, 5.5]);
    expect(autoEdges([7])).toEqual([6, 8]);
    expect(autoEdges([0])).toEqual([-0.5, 0.5]);
    expect(autoEdges([])).toEqual([]);
  });

  it("never cuts a wide spread into more than 40 bins", () => {
    const values = [...Array.from({ length: 200 }, (_, i) => 100 + (i % 10)), 100000];
    expect(autoEdges(values).length - 1).toBeLessThanOrEqual(40);
  });
});

describe("histogram", () => {
  it("counts each group into shared bins: a value on an inner edge goes up, the last edge is included", () => {
    expect(histogram([0, 10, 20], [[0, 9.9, 10, 20], [15]])).toEqual({ edges: [0, 10, 20], counts: [[2, 2], [0, 1]], outside: 0 });
  });

  it("counts values outside given edges as left out, and reads numeric labels", () => {
    expect(histogram(["0", " 10 ", 20], [[-1, 5, 25]])).toEqual({ edges: [0, 10, 20], counts: [[1, 0]], outside: 2 });
  });

  it("bins all groups together when labels are empty", () => {
    expect(histogram([], [[1, 2], [9, 10]])?.edges).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("refuses labels that are not ascending numbers", () => {
    expect(histogram(["a", "b"], [[1]])).toBeNull();
    expect(histogram([10, 0], [[1]])).toBeNull();
    expect(histogram([5], [[1]])).toBeNull();
  });
});
