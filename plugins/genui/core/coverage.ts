// What `Coverage` shows, from the reports it reads: istanbul's
// `coverage-summary.json` (the json-summary reporter of vitest, jest, nyc),
// `lcov.info`, coverage.py's `coverage json` and Go's `coverage.out`. Each
// becomes per-file ratios plus, where the format knows them, the uncovered
// line ranges; then the totals, the directory tree and the tone. Pure: no
// React, no DOM.
import { count, fieldsOf, listOf, plainLines, positiveInteger, reportPath, type Fields } from "./fields";
import type { Value } from "./types";

/** Covered of total (lines, statements, branches or functions). */
export interface Ratio {
  readonly covered: number;
  readonly total: number;
}

/** A run of uncovered lines from `start` to `end` (1-based, inclusive); `missed` are its executable lines that never ran. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
  readonly missed: readonly number[];
}

export type CoverageFormat = "istanbul" | "lcov" | "coverage.py" | "go";

/** What a report counts its headline in: lines, or statements for Go (it has no line metric). */
export type CoverageUnit = "lines" | "statements";

export interface CoverageMetrics {
  readonly lines: Ratio | null;
  readonly statements: Ratio | null;
  readonly branches: Ratio | null;
  readonly functions: Ratio | null;
}

export interface FileCoverage extends CoverageMetrics {
  readonly path: string;
  /** Uncovered lines (statements for Go): what "most uncovered" sorts by. */
  readonly missed: number;
  /** The uncovered ranges; null where the format only has totals (coverage-summary.json). */
  readonly uncovered: readonly LineRange[] | null;
}

export interface CoverageReport {
  readonly format: CoverageFormat;
  readonly unit: CoverageUnit;
  readonly total: CoverageMetrics;
  readonly files: readonly FileCoverage[];
}

export type CoverageResult = { readonly ok: true; readonly report: CoverageReport } | { readonly ok: false; readonly error: string };

const SHAPE_HINT = "Coverage needs coverage-summary.json, lcov.info, coverage.py JSON or Go coverage.out";

/** A whole percentage of a ratio; null when there is nothing to cover. */
export function percent(ratio: Ratio | null): number | null {
  return ratio === null || ratio.total === 0 ? null : (ratio.covered / ratio.total) * 100;
}

/** The ratio a report's headline uses. */
export function headline(metrics: CoverageMetrics, unit: CoverageUnit): Ratio | null {
  return unit === "lines" ? (metrics.lines ?? metrics.statements) : (metrics.statements ?? metrics.lines);
}

export type CoverageTone = "good" | "warn" | "bad";

/** ≥ 80 % good, ≥ 60 % warn, below bad. */
export function coverageTone(value: number): CoverageTone {
  return value >= 80 ? "good" : value >= 60 ? "warn" : "bad";
}

/**
 * `84.7%`, `100%`, `0%`: one decimal, rounded as the tools print it (Go's
 * 74.2 %), except that a file with one missed line never reads 100 % and one
 * with a covered line never reads 0 %.
 */
export function formatPercent(value: number): string {
  const rounded = Math.min(Math.max(Math.round(value * 10) / 10, value > 0 ? 0.1 : 0), value < 100 ? 99.9 : 100);
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function sum(ratios: readonly (Ratio | null)[]): Ratio | null {
  let covered = 0;
  let total = 0;
  let any = false;
  for (const ratio of ratios) {
    if (ratio === null) continue;
    any = true;
    covered += ratio.covered;
    total += ratio.total;
  }
  return any ? { covered, total } : null;
}

function totals(files: readonly CoverageMetrics[]): CoverageMetrics {
  return {
    lines: sum(files.map((file) => file.lines)),
    statements: sum(files.map((file) => file.statements)),
    branches: sum(files.map((file) => file.branches)),
    functions: sum(files.map((file) => file.functions)),
  };
}

/**
 * Uncovered ranges from the executable lines' hits: runs of missed lines,
 * joined across lines that aren't executable (blanks, comments) but broken
 * by any line that ran.
 */
export function uncoveredRanges(hits: ReadonlyMap<number, boolean>): LineRange[] {
  const lines = [...hits.keys()].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  let open: { start: number; end: number; missed: number[] } | null = null;
  for (const line of lines) {
    if (hits.get(line)) {
      if (open !== null) ranges.push(open);
      open = null;
    } else if (open === null) open = { start: line, end: line, missed: [line] };
    else {
      open.end = line;
      open.missed.push(line);
    }
  }
  if (open !== null) ranges.push(open);
  return ranges;
}

// ---------------------------------------------------------------------------
// istanbul coverage-summary.json

function istanbulRatio(value: Value | undefined): Ratio | null {
  const fields = fieldsOf(value);
  const total = count(fields?.total);
  const covered = count(fields?.covered);
  return total === null || covered === null ? null : { covered: Math.min(covered, total), total };
}

function istanbulMetrics(fields: Fields): CoverageMetrics {
  return {
    lines: istanbulRatio(fields.lines),
    statements: istanbulRatio(fields.statements),
    branches: istanbulRatio(fields.branches),
    functions: istanbulRatio(fields.functions),
  };
}

function isIstanbulSummary(object: Fields): boolean {
  const total = fieldsOf(object.total);
  return total !== null && (istanbulRatio(total.lines) !== null || istanbulRatio(total.statements) !== null);
}

function fromIstanbul(object: Fields): CoverageReport {
  const files: FileCoverage[] = [];
  for (const [path, value] of Object.entries(object)) {
    const fields = fieldsOf(value);
    if (path === "total" || fields === null) continue;
    const metrics = istanbulMetrics(fields);
    const lines = metrics.lines ?? metrics.statements;
    files.push({ path: reportPath(path), ...metrics, missed: lines === null ? 0 : lines.total - lines.covered, uncovered: null });
  }
  return { format: "istanbul", unit: "lines", total: istanbulMetrics(fieldsOf(object.total)!), files };
}

// ---------------------------------------------------------------------------
// lcov.info

function isLcov(text: string): boolean {
  return /^SF:/m.test(text) && /^end_of_record/m.test(text);
}

function fromLcov(text: string): CoverageReport {
  const files: FileCoverage[] = [];
  let path: string | null = null;
  let hits = new Map<number, boolean>();
  let found: Record<"LF" | "LH" | "FNF" | "FNH" | "BRF" | "BRH", number | null> = { LF: null, LH: null, FNF: null, FNH: null, BRF: null, BRH: null };
  let functionHits = new Map<string, boolean>();
  let branches = { total: 0, covered: 0 };
  const ratio = (covered: number | null, total: number | null): Ratio | null =>
    total === null ? null : { covered: Math.min(covered ?? 0, total), total };
  for (const raw of plainLines(text)) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    const tag = colon === -1 ? line : line.slice(0, colon);
    const rest = colon === -1 ? "" : line.slice(colon + 1);
    switch (tag) {
      case "SF":
        path = reportPath(rest);
        hits = new Map();
        found = { LF: null, LH: null, FNF: null, FNH: null, BRF: null, BRH: null };
        functionHits = new Map();
        branches = { total: 0, covered: 0 };
        break;
      case "DA": {
        const [lineText, hitText] = rest.split(",");
        const number = positiveInteger(lineText);
        if (number !== null) hits.set(number, (hits.get(number) ?? false) || Number(hitText) > 0);
        break;
      }
      case "FNDA": {
        const comma = rest.indexOf(",");
        const name = rest.slice(comma + 1);
        functionHits.set(name, (functionHits.get(name) ?? false) || Number(rest.slice(0, comma)) > 0);
        break;
      }
      case "BRDA": {
        const taken = rest.split(",")[3];
        branches.total++;
        if (taken !== undefined && taken !== "-" && Number(taken) > 0) branches.covered++;
        break;
      }
      case "LF":
      case "LH":
      case "FNF":
      case "FNH":
      case "BRF":
      case "BRH":
        found[tag] = count(rest);
        break;
      case "end_of_record": {
        if (path === null) break;
        let covered = 0;
        for (const ran of hits.values()) if (ran) covered++;
        const lines = hits.size > 0 ? { covered, total: hits.size } : ratio(found.LH, found.LF);
        let functionsCovered = 0;
        for (const ran of functionHits.values()) if (ran) functionsCovered++;
        files.push({
          path,
          lines,
          statements: null,
          branches: found.BRF !== null ? ratio(found.BRH, found.BRF) : branches.total > 0 ? branches : null,
          functions: found.FNF !== null ? ratio(found.FNH, found.FNF) : functionHits.size > 0 ? { covered: functionsCovered, total: functionHits.size } : null,
          missed: lines === null ? 0 : lines.total - lines.covered,
          uncovered: hits.size > 0 ? uncoveredRanges(hits) : null,
        });
        path = null;
        break;
      }
    }
  }
  return { format: "lcov", unit: "lines", total: totals(files), files };
}

// ---------------------------------------------------------------------------
// coverage.py JSON

function isCoveragePy(object: Fields): boolean {
  const files = fieldsOf(object.files);
  if (files === null) return false;
  const first = fieldsOf(Object.values(files)[0]);
  return first === null ? fieldsOf(object.totals) !== null : fieldsOf(first.summary) !== null || Array.isArray(first.missing_lines);
}

function pyMetrics(summary: Fields | null): CoverageMetrics {
  const statements = count(summary?.num_statements);
  const covered = count(summary?.covered_lines);
  const branchTotal = count(summary?.num_branches);
  const branchCovered = count(summary?.covered_branches);
  return {
    lines: statements === null || covered === null ? null : { covered: Math.min(covered, statements), total: statements },
    statements: null,
    branches: branchTotal === null || branchCovered === null ? null : { covered: Math.min(branchCovered, branchTotal), total: branchTotal },
    functions: null,
  };
}

function fromCoveragePy(object: Fields): CoverageReport {
  const files: FileCoverage[] = [];
  for (const [path, value] of Object.entries(fieldsOf(object.files) ?? {})) {
    const fields = fieldsOf(value);
    if (fields === null) continue;
    const hits = new Map<number, boolean>();
    for (const line of listOf(fields.executed_lines)) {
      const number = positiveInteger(line);
      if (number !== null) hits.set(number, true);
    }
    for (const line of listOf(fields.missing_lines)) {
      const number = positiveInteger(line);
      if (number !== null && !hits.has(number)) hits.set(number, false);
    }
    let metrics = pyMetrics(fieldsOf(fields.summary));
    if (metrics.lines === null && hits.size > 0) {
      let covered = 0;
      for (const ran of hits.values()) if (ran) covered++;
      metrics = { ...metrics, lines: { covered, total: hits.size } };
    }
    const lines = metrics.lines;
    files.push({
      path: reportPath(path),
      ...metrics,
      missed: lines === null ? 0 : lines.total - lines.covered,
      uncovered: Array.isArray(fields.missing_lines) ? uncoveredRanges(hits) : null,
    });
  }
  const given = fieldsOf(object.totals);
  return { format: "coverage.py", unit: "lines", total: given === null ? totals(files) : pyMetrics(given), files };
}

// ---------------------------------------------------------------------------
// Go coverage.out

const GO_BLOCK = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/;

function isGoProfile(text: string): boolean {
  return /^mode: (?:set|count|atomic)\s*$/m.test(text);
}

function fromGo(text: string): CoverageReport {
  // The same block appears once per test binary with -coverpkg; it ran if it ran in any.
  const blocks = new Map<string, { file: string; startLine: number; endLine: number; statements: number; ran: boolean }>();
  for (const raw of plainLines(text)) {
    const match = GO_BLOCK.exec(raw.trim());
    if (match === null) continue;
    const [, file, startLine, startColumn, endLine, endColumn, statements, hits] = match;
    const key = `${file}:${startLine}.${startColumn},${endLine}.${endColumn}`;
    const ran = Number(hits) > 0;
    const known = blocks.get(key);
    if (known !== undefined) known.ran ||= ran;
    else blocks.set(key, { file: file!, startLine: Number(startLine), endLine: Number(endLine), statements: Number(statements), ran });
  }
  const byFile = new Map<string, { covered: number; total: number; ranLines: Set<number>; missedLines: Set<number> }>();
  for (const block of blocks.values()) {
    let file = byFile.get(block.file);
    if (file === undefined) byFile.set(block.file, (file = { covered: 0, total: 0, ranLines: new Set(), missedLines: new Set() }));
    file.total += block.statements;
    if (block.ran) file.covered += block.statements;
    const lines = block.ran ? file.ranLines : file.missedLines;
    for (let line = block.startLine; line <= block.endLine; line++) lines.add(line);
  }
  const files: FileCoverage[] = [...byFile].map(([path, file]) => {
    // A line a block that ran also touches (a closing brace, an `else`) isn't uncovered.
    const hits = new Map<number, boolean>();
    for (const line of file.ranLines) hits.set(line, true);
    for (const line of file.missedLines) if (!hits.has(line)) hits.set(line, false);
    return {
      path,
      lines: null,
      statements: { covered: file.covered, total: file.total },
      branches: null,
      functions: null,
      missed: file.total - file.covered,
      uncovered: uncoveredRanges(hits),
    };
  });
  return { format: "go", unit: "statements", total: totals(files), files };
}

// ---------------------------------------------------------------------------

/** The coverage `value` describes: a loaded report (object or text). */
export function readCoverage(value: Value | undefined): CoverageResult {
  if (typeof value === "string") {
    if (isGoProfile(value)) return { ok: true, report: fromGo(value) };
    if (isLcov(value)) return { ok: true, report: fromLcov(value) };
    return { ok: false, error: `${SHAPE_HINT}; this text is neither lcov (SF:… end_of_record) nor a Go profile (mode: …)` };
  }
  const object = fieldsOf(value);
  if (object === null) return { ok: false, error: SHAPE_HINT };
  if (isIstanbulSummary(object)) return { ok: true, report: fromIstanbul(object) };
  if (isCoveragePy(object)) return { ok: true, report: fromCoveragePy(object) };
  return { ok: false, error: SHAPE_HINT };
}

// ---------------------------------------------------------------------------
// Views

/** Files with the most uncovered lines (statements for Go) first, then the lowest coverage, then by path. */
export function mostUncovered(files: readonly FileCoverage[], unit: CoverageUnit): FileCoverage[] {
  return [...files].sort((a, b) => {
    if (b.missed !== a.missed) return b.missed - a.missed;
    const pa = percent(headline(a, unit)) ?? 100;
    const pb = percent(headline(b, unit)) ?? 100;
    return pa - pb || a.path.localeCompare(b.path);
  });
}

export interface CoverageFolder {
  readonly kind: "folder";
  /** The folder's name, single-child chains joined (`src/core`). */
  readonly name: string;
  /** Path from the shown root, for keys and labels. */
  readonly path: string;
  readonly children: readonly CoverageNode[];
  readonly metrics: CoverageMetrics;
  readonly missed: number;
  readonly fileCount: number;
}

export interface CoverageLeaf {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly file: FileCoverage;
}

export type CoverageNode = CoverageFolder | CoverageLeaf;

interface Building {
  folders: Map<string, Building>;
  files: { name: string; file: FileCoverage }[];
}

/**
 * Files as a directory tree under the shown paths (`shown` gives each file's
 * display path), folders first then files, by name; folders with one child
 * folder and no files fold into it (`src/core`).
 */
export function coverageTree(files: readonly FileCoverage[], shown: (file: FileCoverage) => string): CoverageNode[] {
  const root: Building = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = shown(file).split("/").filter((part) => part !== "");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part);
      if (next === undefined) at.folders.set(part, (next = { folders: new Map(), files: [] }));
      at = next;
    }
    at.files.push({ name: parts.at(-1) ?? shown(file), file });
  }
  const build = (at: Building, prefix: string): CoverageNode[] => {
    const folders = [...at.folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, folder]): CoverageFolder => {
        let label = name;
        let inner = folder;
        while (inner.files.length === 0 && inner.folders.size === 1) {
          const [childName, child] = inner.folders.entries().next().value!;
          label = `${label}/${childName}`;
          inner = child;
        }
        const path = `${prefix}${label}`;
        const children = build(inner, `${path}/`);
        const leaves = collectFiles(children);
        return {
          kind: "folder",
          name: label,
          path,
          children,
          metrics: totals(leaves),
          missed: leaves.reduce((total, file) => total + file.missed, 0),
          fileCount: leaves.length,
        };
      });
    const leaves = [...at.files]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, file }): CoverageLeaf => ({ kind: "file", name, path: `${prefix}${name}`, file }));
    return [...folders, ...leaves];
  };
  return build(root, "");
}

function collectFiles(nodes: readonly CoverageNode[]): FileCoverage[] {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.file] : collectFiles(node.children)));
}

/** `12–18`, or `12` for one line. */
export function rangeLabel(range: LineRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}–${range.end}`;
}
