import { describe, expect, test } from "bun:test";
import { HINT_ALPHABET, hintLabels } from "./hint-labels.ts";

describe("hintLabels", () => {
  test("returns nothing for zero or negative counts", () => {
    expect(hintLabels(0)).toEqual([]);
    expect(hintLabels(-3)).toEqual([]);
  });

  test("covers the count with unique labels", () => {
    for (const count of [1, 2, 13, 14, 15, 196, 197, 500]) {
      const labels = hintLabels(count);
      expect(labels.length).toBe(count);
      expect(new Set(labels).size).toBe(count);
    }
  });

  test("uses only alphabet characters", () => {
    for (const label of hintLabels(300)) {
      for (const char of label) expect(HINT_ALPHABET).toContain(char);
    }
  });

  test("uses the smallest uniform length that fits the count", () => {
    expect(hintLabels(1).every((label) => label.length === 1)).toBe(true);
    expect(hintLabels(14).every((label) => label.length === 1)).toBe(true);
    expect(hintLabels(15).every((label) => label.length === 2)).toBe(true);
    expect(hintLabels(196).every((label) => label.length === 2)).toBe(true);
    expect(hintLabels(197).every((label) => label.length === 3)).toBe(true);
  });

  test("is prefix-free", () => {
    for (const count of [1, 14, 15, 40, 197]) {
      const labels = hintLabels(count);
      for (const a of labels) {
        for (const b of labels) {
          if (a === b) continue;
          expect(a.startsWith(b)).toBe(false);
        }
      }
    }
  });

  test("respects a custom alphabet", () => {
    expect(hintLabels(2, "ab")).toEqual(["a", "b"]);
    expect(hintLabels(3, "ab")).toEqual(["aa", "ab", "ba"]);
  });
});
