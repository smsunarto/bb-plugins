import { describe, expect, it } from "vitest";
import {
  addItem,
  decimals,
  isoDate,
  itemProblem,
  radioOptions,
  ratingMax,
  ratingValue,
  replaceItem,
  starFill,
  stepBy,
  stepRange,
  stepperValue,
} from "./fieldLogic";

describe("decimals", () => {
  it("counts written decimal places, including exponent notation", () => {
    expect(decimals(3)).toBe(0);
    expect(decimals(0.25)).toBe(2);
    expect(decimals(1e-7)).toBe(7);
    expect(decimals(1.5e-7)).toBe(8);
    expect(decimals(1e21)).toBe(0);
  });
});

describe("stepRange", () => {
  it("defaults the step to 1 and rejects non-positive steps", () => {
    expect(stepRange(undefined, undefined, undefined)).toEqual({ min: null, max: null, step: 1 });
    expect(stepRange(0, 10, 0).step).toBe(1);
    expect(stepRange(0, 10, -2).step).toBe(1);
    expect(stepRange(0, 10, "2").step).toBe(1);
  });

  it("never lets max sit below min", () => {
    expect(stepRange(5, 2, 1)).toEqual({ min: 5, max: 5, step: 1 });
  });
});

describe("stepBy", () => {
  it("steps fractions without float drift", () => {
    const range = stepRange(null, null, 0.1);
    let value = 0;
    for (let i = 0; i < 3; i++) value = stepBy(value, 1, range);
    expect(value).toBe(0.3);
    expect(stepBy(0.3, -1, range)).toBe(0.2);
    expect(stepBy(1.15, 1, stepRange(null, null, 0.05))).toBe(1.2);
  });

  it("keeps a preset value's finer precision", () => {
    expect(stepBy(1.25, 1, stepRange(null, null, 1))).toBe(2.25);
  });

  it("clamps to the bounds", () => {
    const range = stepRange(0, 1, 0.3);
    expect(stepBy(0.9, 1, range)).toBe(1);
    expect(stepBy(0.1, -1, range)).toBe(0);
    expect(stepBy(1, 1, range)).toBe(1);
  });

  it("jumps to a bound on ±Infinity and stays put without one", () => {
    expect(stepBy(4, Infinity, stepRange(0, 9, 1))).toBe(9);
    expect(stepBy(4, -Infinity, stepRange(0, 9, 1))).toBe(0);
    expect(stepBy(4, Infinity, stepRange(0, null, 1))).toBe(4);
  });
});

describe("stepperValue", () => {
  it("starts from min, else 0, and clamps a preset state", () => {
    expect(stepperValue(null, stepRange(2, 8, 1))).toBe(2);
    expect(stepperValue(undefined, stepRange(null, null, 1))).toBe(0);
    expect(stepperValue(-3, stepRange(null, 5, 1))).toBe(-3);
    expect(stepperValue(12, stepRange(0, 10, 1))).toBe(10);
    expect(stepperValue("7", stepRange(1, 10, 1))).toBe(1);
  });
});

describe("radioOptions", () => {
  it("accepts scalars and {value, detail?} objects and drops the rest", () => {
    expect(radioOptions(["a", 2, null, { value: "b", detail: "Second" }, { value: "c" }, { detail: "x" }, ["d"]])).toEqual([
      { value: "a", detail: null },
      { value: 2, detail: null },
      { value: null, detail: null },
      { value: "b", detail: "Second" },
      { value: "c", detail: null },
    ]);
  });

  it("ignores empty and non-scalar details", () => {
    expect(radioOptions([{ value: 1, detail: "" }, { value: 2, detail: ["x"] }, { value: 3, detail: 4 }])).toEqual([
      { value: 1, detail: null },
      { value: 2, detail: null },
      { value: 3, detail: "4" },
    ]);
  });

  it("is empty for a non-list", () => {
    expect(radioOptions("a")).toEqual([]);
  });
});

describe("list editing", () => {
  it("appends a trimmed item", () => {
    expect(addItem(["a"], "  b ")).toEqual(["a", "b"]);
  });

  it("rejects empty drafts and duplicates, comparing entries as text", () => {
    expect(itemProblem(["a"], "   ")).toBe("empty");
    expect(itemProblem(["a"], " a ")).toBe("duplicate");
    expect(itemProblem([3], "3")).toBe("duplicate");
    expect(addItem(["a"], "a")).toBeNull();
    expect(addItem([], "")).toBeNull();
  });

  it("replaces an entry in place under the same rules, ignoring the entry itself", () => {
    expect(replaceItem(["a", "b"], 0, " c ")).toEqual(["c", "b"]);
    expect(replaceItem(["a", "b"], 0, "b")).toBeNull();
    expect(replaceItem(["a", "b"], 0, " ")).toBeNull();
    expect(replaceItem(["a", "b"], 0, " a ")).toBeNull();
    expect(replaceItem(["a", "b"], 5, "c")).toBeNull();
  });

  it("turns a non-string entry into text when it is edited", () => {
    expect(replaceItem([1, "b"], 0, "1")).toEqual(["1", "b"]);
  });
});

describe("isoDate", () => {
  it("accepts real yyyy-mm-dd dates only", () => {
    expect(isoDate("2026-02-28")).toBe("2026-02-28");
    expect(isoDate("2024-02-29")).toBe("2024-02-29");
    expect(isoDate("2026-02-29")).toBeNull();
    expect(isoDate("2026-13-01")).toBeNull();
    expect(isoDate("2026-1-01")).toBeNull();
    expect(isoDate("2026-01-01T00:00")).toBeNull();
    expect(isoDate(20260101)).toBeNull();
    expect(isoDate(null)).toBeNull();
  });
});

describe("rating", () => {
  it("clamps the star count to whole stars from 1 to 10, default 5", () => {
    expect(ratingMax(undefined)).toBe(5);
    expect(ratingMax(0)).toBe(1);
    expect(ratingMax(40)).toBe(10);
    expect(ratingMax(3.6)).toBe(4);
  });

  it("clamps the value to 0..max", () => {
    expect(ratingValue(null, 5)).toBe(0);
    expect(ratingValue(-1, 5)).toBe(0);
    expect(ratingValue(9, 5)).toBe(5);
    expect(ratingValue(3.5, 5)).toBe(3.5);
  });

  it("fills stars up to the value, with a partial star for fractions", () => {
    expect([1, 2, 3, 4, 5].map((star) => starFill(3.5, star))).toEqual([1, 1, 1, 0.5, 0]);
  });
});
