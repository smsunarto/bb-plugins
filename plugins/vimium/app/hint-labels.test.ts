import { describe, expect, test } from "bun:test";
import {
  GENERAL_ALPHABET,
  HINT_ALPHABET,
  RESERVED_COMPOSER_CONTROLS,
  assignTopLevelLabels,
  hintLabels,
  type TopLevelFact,
} from "./hint-labels.ts";

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

  test("a minimum length forces longer labels even for small counts", () => {
    expect(hintLabels(2, "ab", 2)).toEqual(["aa", "ab"]);
    expect(hintLabels(5, "ab", 2).every((label) => label.length === 3)).toBe(true);
  });
});

describe("GENERAL_ALPHABET", () => {
  test("excludes every reserved composer character", () => {
    for (const control of RESERVED_COMPOSER_CONTROLS) {
      expect(GENERAL_ALPHABET).not.toContain(control.char);
    }
  });

  test("has no duplicates and enough range to keep a diff-heavy screen at two characters", () => {
    expect(new Set(GENERAL_ALPHABET).size).toBe(GENERAL_ALPHABET.length);
    expect(GENERAL_ALPHABET.length ** 2).toBeGreaterThanOrEqual(196);
  });
});

describe("assignTopLevelLabels", () => {
  const general = (): TopLevelFact => ({ reservedChar: null, isThreadRow: false });
  const thread = (): TopLevelFact => ({ reservedChar: null, isThreadRow: true });
  const reserved = (char: string): TopLevelFact => ({ reservedChar: char, isThreadRow: false });

  test("reserved controls keep their pinned character regardless of position", () => {
    expect(assignTopLevelLabels([general(), reserved("m"), reserved("s")])).toEqual([
      "dd",
      "m",
      "s",
    ]);
  });

  test("a duplicate reserved match falls back to a general label", () => {
    const labels = assignTopLevelLabels([reserved("m"), reserved("m")]);
    expect(labels[0]).toBe("m");
    expect(labels[1]?.length).toBe(2);
  });

  test("thread rows count 1-9 in order, the tenth goes general", () => {
    const facts = Array.from({ length: 10 }, thread);
    const labels = assignTopLevelLabels([general(), ...facts]);
    expect(labels.slice(1, 10)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(labels[10]?.length).toBe(2);
  });

  test("general labels are never a single character", () => {
    for (const label of assignTopLevelLabels(Array.from({ length: 30 }, general))) {
      expect(label.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("the mixed label set is prefix-free", () => {
    const labels = assignTopLevelLabels([
      reserved("m"),
      reserved("p"),
      thread(),
      thread(),
      ...Array.from({ length: 20 }, general),
    ]);
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue;
        expect(a.startsWith(b)).toBe(false);
      }
    }
  });
});
