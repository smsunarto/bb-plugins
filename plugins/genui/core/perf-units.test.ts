import { describe, expect, it } from "vitest";
import { formatAmount, formatDelta, formatPercent, formatShare, niceTicks, significant, unitInfo } from "./perf-units";

describe("unitInfo", () => {
  it("tells time, bytes, rates, percent and counts apart", () => {
    expect(unitInfo("ms")).toMatchObject({ kind: "time", factor: 1e-3 });
    expect(unitInfo("µs")).toMatchObject({ kind: "time", factor: 1e-6 });
    expect(unitInfo("seconds")).toMatchObject({ kind: "time", factor: 1 });
    expect(unitInfo("MB")).toMatchObject({ kind: "bytes", factor: 1024 ** 2 });
    expect(unitInfo("ops/s")).toMatchObject({ kind: "rate" });
    expect(unitInfo("Hz")).toMatchObject({ kind: "rate", label: "ops/s" });
    expect(unitInfo("%")).toMatchObject({ kind: "percent" });
    expect(unitInfo("req")).toEqual({ kind: "count", factor: 1, label: "req" });
    expect(unitInfo(null)).toEqual({ kind: "count", factor: 1, label: null });
    // "m" is metres as often as minutes: a count.
    expect(unitInfo("m").kind).toBe("count");
  });
});

describe("formatAmount", () => {
  it("scales times to the unit a person reads", () => {
    expect(formatAmount(0.0277, "ms")).toBe("27.7 µs");
    expect(formatAmount(1840, "ms")).toBe("1.84 s");
    expect(formatAmount(0.00781, "s")).toBe("7.81 ms");
    expect(formatAmount(184.4, "ms")).toBe("184 ms");
    expect(formatAmount(390, "s")).toBe("6.5 min");
    expect(formatAmount(0, "ms")).toBe("0 ms");
  });

  it("scales bytes in 1,024s", () => {
    expect(formatAmount(512, "B")).toBe("512 B");
    expect(formatAmount(349438, "B")).toBe("341 KB");
    expect(formatAmount(161368, "KB")).toBe("158 MB");
    expect(formatAmount(1.5, "GB")).toBe("1.5 GB");
  });

  it("compacts rates and big counts, keeps small counts whole", () => {
    expect(formatAmount(36074.6, "ops/s")).toBe("36.1K ops/s");
    expect(formatAmount(1234, "req")).toBe("1,234 req");
    expect(formatAmount(2_500_000, null)).toBe("2.5M");
    expect(formatAmount(12.5, "%")).toBe("12.5%");
    expect(formatAmount(1200, "$")).toBe("$1,200");
  });

  it("never prints NaN", () => {
    expect(formatAmount(Number.NaN, "ms")).toBe("—");
  });

  it("scales by a reference so a spread reads in its mean's unit", () => {
    expect(formatAmount(0.000748, "s", 2, 0.0078)).toBe("0.75 ms");
    expect(formatAmount(300, "ms", 3, 1500)).toBe("0.3 s");
  });
});

describe("signed values", () => {
  it("signs deltas and percents with a true minus", () => {
    expect(formatDelta(-12.3, "ms")).toBe("−12.3 ms");
    expect(formatDelta(2048, "B")).toBe("+2 KB");
    expect(formatDelta(0, "ms")).toBe("±0 ms");
    expect(formatPercent(-4.04)).toBe("−4.0%");
    expect(formatPercent(0.04)).toBe("+<0.1%");
    expect(formatPercent(250)).toBe("+250%");
  });

  it("shares a whole", () => {
    expect(formatShare(41, 100)).toBe("41%");
    expect(formatShare(3.24, 100)).toBe("3.2%");
    expect(formatShare(0.01, 100)).toBe("<0.1%");
    expect(formatShare(1, 0)).toBe("");
  });

  it("rounds to significant digits", () => {
    expect(significant(1.8432)).toBe("1.84");
    expect(significant(18432)).toBe("18,432");
    expect(significant(0.000123)).toBe("0.000123");
  });
});

describe("niceTicks", () => {
  it("covers the range at 1, 2 or 5 × 10ⁿ", () => {
    expect(niceTicks(0, 388)).toEqual([0, 100, 200, 300, 400]);
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(7.1, 34.7)).toEqual([0, 10, 20, 30, 40]);
  });

  it("survives an empty range", () => {
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});
