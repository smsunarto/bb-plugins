import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  coverageTone,
  coverageTree,
  formatPercent,
  headline,
  mostUncovered,
  percent,
  readCoverage,
  uncoveredRanges,
  type CoverageFolder,
  type CoverageReport,
} from "./coverage";
import type { Value } from "./types";

const fixture = (name: string) => readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8");

function read(value: Value): CoverageReport {
  const result = readCoverage(value);
  if (!result.ok) throw new Error(result.error);
  return result.report;
}

describe("readCoverage", () => {
  it("reads vitest's coverage-summary.json (istanbul json-summary): totals as given, per-file metrics, no line data", () => {
    const report = read(JSON.parse(fixture("coverage-summary.json")) as Value);
    expect(report.format).toBe("istanbul");
    expect(report.total.lines).toEqual({ covered: 2474, total: 2654 });
    expect(report.total.branches).toEqual({ covered: 2475, total: 2934 });
    const markdown = report.files.find((file) => file.path.endsWith("core/markdown.ts"))!;
    expect(markdown.path).toBe("/home/dev/bb-plugin-genui/core/markdown.ts");
    expect(markdown.uncovered).toBeNull();
    expect(markdown.missed).toBe(markdown.lines!.total - markdown.lines!.covered);
  });

  it("reads lcov.info from vitest: DA hits as ranges joined across non-executable lines, FN/BR totals", () => {
    const report = read(fixture("lcov.info"));
    expect(report.format).toBe("lcov");
    expect(report.total).toEqual({
      lines: { covered: 41, total: 107 },
      statements: null,
      branches: { covered: 14, total: 65 },
      functions: { covered: 12, total: 22 },
    });
    const map = report.files.find((file) => file.path === "data/src/mapMath.ts")!;
    expect(map.missed).toBe(20);
    expect(map.uncovered!.map((range) => [range.start, range.end, range.missed.length])).toEqual([
      [66, 74, 9],
      [89, 103, 11],
    ]);
  });

  it("reads lcov written by other tools: CRLF, absolute and Windows paths, LF/LH without DA, BRDA and FNDA", () => {
    const text = [
      "TN:",
      "SF:C:\\work\\app\\src\\a.ts",
      "FNDA:3,used",
      "FNDA:0,unused",
      "BRDA:4,0,0,1",
      "BRDA:4,0,1,-",
      "DA:1,1",
      "DA:2,0",
      "DA:3,0",
      "DA:5,2",
      "DA:6,0",
      "end_of_record",
      "SF:/repo/src/b.ts",
      "LF:10",
      "LH:7",
      "end_of_record",
    ].join("\r\n");
    const report = read(text);
    expect(report.files.map((file) => [file.path, file.lines, file.functions, file.branches])).toEqual([
      ["C:/work/app/src/a.ts", { covered: 2, total: 5 }, { covered: 1, total: 2 }, { covered: 1, total: 2 }],
      ["/repo/src/b.ts", { covered: 7, total: 10 }, null, null],
    ]);
    expect(report.files[0]!.uncovered!.map((range) => [range.start, range.end])).toEqual([
      [2, 3],
      [6, 6],
    ]);
    expect(report.files[1]!.uncovered).toBeNull();
  });

  it("reads coverage.py JSON: statements as lines, branches, missing_lines as ranges", () => {
    const report = read(JSON.parse(fixture("coverage-py.json")) as Value);
    expect(report.format).toBe("coverage.py");
    expect(report.total.lines).toEqual({ covered: 38, total: 50 });
    expect(report.total.branches).toEqual({ covered: 19, total: 26 });
    const file = report.files[0]!;
    expect(file.path).toBe("data/src/durations.py");
    expect(file.missed).toBe(12);
    // 47–51 is the bare except's body: one run; 18–19 the minutes branch.
    expect(file.uncovered!.map((range) => [range.start, range.end])).toEqual([
      [15, 15],
      [18, 19],
      [29, 29],
      [35, 35],
      [43, 43],
      [47, 51],
      [60, 60],
    ]);
  });

  it("reads a Go coverage.out: statements per file, uncovered blocks as ranges, repeated blocks merged", () => {
    const report = read(fixture("coverage.out"));
    expect(report.format).toBe("go");
    expect(report.unit).toBe("statements");
    expect(headline(report.total, report.unit)).toEqual({ covered: 23, total: 31 });
    expect(report.files[0]!.uncovered!.map((range) => [range.start, range.end])).toEqual([
      [28, 29],
      [44, 45],
      [54, 54],
      [66, 72],
    ]);
    const merged = read("mode: atomic\nex.com/m/a.go:1.1,3.2 2 0\nex.com/m/a.go:1.1,3.2 2 5\nex.com/m/a.go:4.1,5.2 1 0\n");
    expect(merged.files[0]).toMatchObject({ path: "ex.com/m/a.go", statements: { covered: 2, total: 3 }, missed: 1 });
    expect(merged.files[0]!.uncovered!.map((range) => [range.start, range.end])).toEqual([[4, 5]]);
  });

  it("refuses what it can't read and keeps empty reports honest", () => {
    expect(readCoverage("hello").ok).toBe(false);
    expect(readCoverage([1, 2]).ok).toBe(false);
    expect(readCoverage({ total: { nope: 1 } }).ok).toBe(false);
    const empty = read("mode: set\n");
    expect(empty.files).toEqual([]);
    expect(percent(headline(empty.total, empty.unit))).toBeNull();
  });

  it("reads a large lcov quickly", () => {
    const records = Array.from({ length: 2000 }, (_, file) =>
      [`SF:src/f${file}.ts`, ...Array.from({ length: 200 }, (_, line) => `DA:${line + 1},${(line + file) % 7 === 0 ? 0 : 1}`), "end_of_record"].join("\n"),
    ).join("\n");
    const started = performance.now();
    const report = read(records);
    expect(report.files).toHaveLength(2000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("views", () => {
  it("sorts by most uncovered, then lowest coverage", () => {
    const report = read(fixture("lcov.info"));
    expect(mostUncovered(report.files, report.unit).map((file) => file.path)).toEqual(["data/src/json-logic.ts", "data/src/mapMath.ts"]);
  });

  it("builds a directory tree with single-child chains folded and folder totals", () => {
    const report = read(JSON.parse(fixture("coverage-summary.json")) as Value);
    const tree = coverageTree(report.files, (file) => file.path.replace("/home/dev/bb-plugin-genui/", ""));
    expect(tree.map((node) => node.name)).toEqual(["core", "ui/components"]);
    const ui = tree[1] as CoverageFolder;
    expect(ui.fileCount).toBe(5);
    expect(ui.metrics.lines!.total).toBe(ui.children.reduce((sum, node) => sum + (node.kind === "file" ? node.file.lines!.total : 0), 0));
  });

  it("formats and tones percentages", () => {
    expect([formatPercent(74.19), formatPercent(100), formatPercent(99.97), formatPercent(0.01), formatPercent(0), formatPercent(80)]).toEqual([
      "74.2%",
      "100%",
      "99.9%",
      "0.1%",
      "0%",
      "80%",
    ]);
    expect([coverageTone(80), coverageTone(79.9), coverageTone(60), coverageTone(59.9)]).toEqual(["good", "warn", "warn", "bad"]);
    expect(uncoveredRanges(new Map())).toEqual([]);
  });
});
