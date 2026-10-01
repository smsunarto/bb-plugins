import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { findMatches, findSurfaceMatches } from "./find.ts";
import { alignRows, lensContext } from "./two-side.ts";

const query = (
  text: string,
  options: Partial<{ matchCase: boolean; wholeWord: boolean; isRegex: boolean }> = {},
) => ({
  text,
  matchCase: false,
  wholeWord: false,
  isRegex: false,
  ...options,
});

describe("findMatches", () => {
  const lines = ["const total = sum(a, b);", "Total: totals", "subtotal.total"];

  it("matches case-insensitively per line with 1-based lines and 0-based columns", () => {
    expect(findMatches(lines, query("total"))).toEqual({
      matchCount: 5,
      matches: [
        { line: 1, start: 6, end: 11 },
        { line: 2, start: 0, end: 5 },
        { line: 2, start: 7, end: 12 },
        { line: 3, start: 3, end: 8 },
        { line: 3, start: 9, end: 14 },
      ],
    });
  });

  it("honors match case, Monaco whole word separators, and regular expressions", () => {
    expect(findMatches(lines, query("Total", { matchCase: true })).matchCount).toBe(1);
    // "subtotal.total": "." separates, so only the second "total" is a whole word.
    expect(findMatches(lines, query("total", { wholeWord: true })).matches).toEqual([
      { line: 1, start: 6, end: 11 },
      { line: 2, start: 0, end: 5 },
      { line: 3, start: 9, end: 14 },
    ]);
    expect(findMatches(lines, query("sum\\(\\w", { isRegex: true })).matches).toEqual([
      { line: 1, start: 14, end: 19 },
    ]);
  });

  it("finds nothing for an empty query, an invalid expression, or only empty matches", () => {
    expect(findMatches(lines, query("")).matchCount).toBe(0);
    expect(findMatches(lines, query("(", { isRegex: true })).matchCount).toBe(0);
    expect(findMatches(lines, query("x*", { isRegex: true })).matchCount).toBe(0);
  });
});

describe("findSurfaceMatches", () => {
  const base = [
    "keep 1",
    "keep 2",
    "old needle",
    "keep 4",
    "keep 5",
    "keep 6",
    "keep 7",
    "keep 8",
    "needle far",
  ];
  const head = [
    "keep 1",
    "keep 2",
    "new needle",
    "keep 4",
    "keep 5",
    "keep 6",
    "keep 7",
    "keep 8",
    "needle far",
  ];
  const rows = alignRows(
    parseDiffFromFile(
      { name: "a.ts", contents: `${base.join("\n")}\n` },
      { name: "a.ts", contents: `${head.join("\n")}\n` },
    ),
  );

  it("counts base then head, skips text outside the lens, and counts an unchanged line once", () => {
    const visible = lensContext(rows, [{ side: "head", fromLine: 3, toLine: 3 }]);
    const matches = findSurfaceMatches({ rows, base, head, visible, query: query("needle") });

    // Row 8 ("needle far") is 6 rows past the range: outside the lens.
    expect(matches.map(({ side, line, row }) => [side, line, row])).toEqual([
      ["base", 3, 2],
      ["head", 3, 2],
    ]);
    const everything = findSurfaceMatches({
      rows,
      base,
      head,
      visible: rows.map(() => true),
      query: query("needle"),
    });

    // The unchanged "needle far" counts once, on the head side.
    expect(everything.map(({ side, line }) => [side, line])).toEqual([
      ["base", 3],
      ["head", 3],
      ["head", 9],
    ]);
  });
});
