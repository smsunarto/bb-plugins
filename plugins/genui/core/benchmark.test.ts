import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bestValues,
  compareContexts,
  formatRatio,
  groupRuns,
  readBenchmark,
  unmeasuredCounts,
  verdictOf,
  type AllRunsReport,
  type CompareReport,
  type RunsReport,
} from "./benchmark";
import { parseDataFile } from "./data";
import type { Value } from "./types";

function fixture(name: string): Value {
  const loaded = parseDataFile(name, readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8"));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

function compare(value: Value, unit: string | null = null): CompareReport {
  const read = readBenchmark(value, unit);
  if (!read.ok || read.report.kind !== "compare") throw new Error("not a comparison");
  return read.report;
}

function runs(value: Value, unit: string | null = null): RunsReport {
  const read = readBenchmark(value, unit);
  if (!read.ok || read.report.kind !== "runs") throw new Error("not runs");
  return read.report;
}

describe("before/after rows", () => {
  it("computes delta, percent and verdict, lower is better by default", () => {
    const report = compare(
      [
        { name: "cold start", before: 420, after: 310 },
        { name: "p95", before: 88, after: 97 },
        { name: "warm", before: 12.0, after: 12.1 },
      ],
      "ms",
    );
    expect(report.rows.map((row) => [row.delta, Math.round(row.percent! * 10) / 10, row.verdict])).toEqual([
      [-110, -26.2, "better"],
      [9, 10.2, "worse"],
      [expect.closeTo(0.1, 6), 0.8, "same"],
    ]);
    expect(report.counts).toEqual({ better: 1, worse: 1, same: 1 });
    expect(report.words).toEqual({ better: "faster", worse: "slower" });
  });

  it("reads higher-is-better rows and per-row units", () => {
    const report = compare([
      { name: "throughput", before: 1200, after: 1500, unit: "req/s", better: "higher" },
      { name: "bundle", before: 512, after: 498, unit: "KB" },
    ]);
    expect(report.rows.map((row) => row.verdict)).toEqual(["better", "better"]);
    expect(report.words).toEqual({ better: "better", worse: "worse" });
    // after/before oriented to "lower is better": 1200/1500 and 498/512.
    expect(report.geomean).toBeCloseTo(Math.sqrt((1200 / 1500) * (498 / 512)), 10);
  });

  it("calls a change within the row's spread the same", () => {
    expect(verdictOf(100, 104, "lower", 5)).toBe("same");
    expect(verdictOf(100, 106, "lower", 5)).toBe("worse");
    expect(compare([{ name: "a", before: 10, after: 12, stddev: 3 }]).rows[0].verdict).toBe("same");
  });

  it("speaks of size for bytes", () => {
    expect(compare([{ name: "app.js", before: 512, after: 498 }], "KB").words).toEqual({ better: "smaller", worse: "larger" });
  });

  it("handles zero baselines, numeric strings and junk", () => {
    const report = compare(["text", { name: "new metric", before: 0, after: 3 }, { name: "strings", before: "10", after: "8" }, { before: 1, after: 2 }]);
    expect(report.rows.map((row) => [row.name, row.percent, row.verdict])).toEqual([
      ["new metric", null, "worse"],
      ["strings", -20, "better"],
    ]);
    expect(report.ignored).toBe(2);
    expect(report.geomean).toBeNull();
  });

  it("is empty for an empty list", () => {
    expect(compare([]).rows).toEqual([]);
  });
});

describe("hyperfine --export-json", () => {
  it("ranks commands and propagates the ratio's spread like hyperfine", () => {
    const report = runs(fixture("hyperfine-startup.json"));
    expect(report.tool).toBe("hyperfine");
    expect(report.unit).toBe("s");
    const [fastest, second, third] = report.groups[0].runs;
    expect(fastest.name).toBe("bun -e 0");
    expect(fastest.ratio).toBe(1);
    expect(second.name).toBe("python3 -c 0");
    expect(third.name).toBe("node -e 0");
    // hyperfine printed "3.92 ± 0.44 times faster than python3 -c 0" and "4.62 ± 0.73 times faster than node -e 0".
    expect(formatRatio(second.ratio, second.ratioStddev)).toBe("3.92 ± 0.44");
    expect(formatRatio(third.ratio, third.ratioStddev)).toBe("4.62 ± 0.73");
    expect(fastest.times).toHaveLength(15);
    expect(fastest.facts.map((fact) => fact.label)).toEqual(["User", "System", "Peak memory", "Runs"]);
    expect(fastest.failed).toBe(false);
  });

  it("marks commands that exited non-zero and names parameter scans", () => {
    const report = runs({
      results: [
        { command: "sleep 0.1", mean: 0.1, stddev: 0.001, min: 0.099, max: 0.102, times: [0.1, 0.099, 0.102], exit_codes: [0, 1, 0] },
        { command: "", parameters: { threads: 4 }, mean: 0.05, stddev: null, min: 0.05, max: 0.05, times: [0.05] },
      ],
    });
    const [first, second] = report.groups[0].runs;
    expect(first.name).toBe("threads=4");
    expect(second.ratioStddev).toBeNull();
    expect(second.failed).toBe(true);
  });
});

describe("vitest bench --outputJson", () => {
  it("reads each group, ranked by mean, in milliseconds", () => {
    const report = runs(fixture("vitest-bench.json"));
    expect(report.tool).toBe("vitest");
    expect(report.unit).toBe("ms");
    expect(report.groups.map((group) => [group.source, group.name, group.runs.map((run) => run.name)])).toEqual([
      ["compile.bench.ts", "compile a spec", ["compileStreaming", "compile"]],
      ["compile.bench.ts", "parse a data file", ["HAR as JSON", "500-row CSV"]],
    ]);
    // vitest printed "3.60x faster than 500-row CSV".
    expect(report.groups[1].runs[1].ratio.toFixed(2)).toBe("3.60");
    expect(report.groups[0].runs[0].facts.map((fact) => fact.label)).toEqual(["Throughput", "± rme", "p99", "Samples"]);
    // The ratio's spread comes from the standard error of the mean, not the 18,038 samples' stddev.
    const compile = report.groups[0].runs[1];
    expect(compile.ratioStddev).toBeLessThan(0.05);
    expect(compile.p99).toBeCloseTo(0.0665, 4);
  });

  it("says so when a report has no benchmarks", () => {
    expect(readBenchmark({ files: [] }, null)).toEqual({ ok: false, error: "This vitest bench report has no benchmarks" });
  });
});

describe("other input", () => {
  it("takes a hand-written list of runs", () => {
    const report = runs([{ name: "a", mean: 30, stddev: 2 }, { name: "b", mean: 10, stddev: 1 }], "ms");
    expect(report.groups[0].runs.map((run) => [run.name, run.ratio])).toEqual([
      ["b", 1],
      ["a", 3],
    ]);
  });

  it("refuses what it can't read", () => {
    expect(readBenchmark("12 ms", null).ok).toBe(false);
    expect(readBenchmark({ foo: 1 }, null).ok).toBe(false);
    expect(readBenchmark(undefined, null).ok).toBe(false);
  });
});

function allRuns(value: Value, unit: string | null = null): AllRunsReport {
  const read = readBenchmark(value, unit);
  if (!read.ok || read.report.kind !== "all-runs") throw new Error("not all runs");
  return read.report;
}

describe("conditions of before/after rows", () => {
  it("leaves rows without conditions as they were", () => {
    const report = compare([{ name: "cold start", before: 420, after: 310 }], "ms");
    expect(report.rows[0]).toMatchObject({ comparability: null, comparable: true, contextBefore: null, contextAfter: null, beforeSamples: [] });
    expect(report.incomparable).toBe(0);
    expect(report.shared).toEqual({});
  });

  it("marks a row whose sides ran under different conditions not comparable, and does not count or judge it", () => {
    const report = compare([
      { name: "Presented FPS, reuse", before: 112.583, after: 114.88, unit: "fps", better: "higher", context: { device: "iPhone", thermal: "Nominal" } },
      {
        name: "Delivered FPS, archive",
        before: 45.464,
        after: 48.849,
        unit: "fps",
        better: "higher",
        context: { device: "iPhone" },
        contextBefore: { thermal: "Serious throughout" },
        contextAfter: { thermal: "Fair → serious" },
      },
      { name: "Render FPS", before: 58, after: 70, unit: "fps", better: "higher", context: { device: "iPhone" } },
    ]);
    const [matched, differs] = report.rows;
    expect(matched.comparability?.state).toBe("matched");
    expect(matched.comparable).toBe(true);
    expect(differs.comparable).toBe(false);
    expect(differs.comparability?.differing).toEqual([{ key: "thermal", before: "Serious throughout", after: "Fair → serious" }]);
    // Its verdict is still computed, but not counted.
    expect(differs.verdict).toBe("better");
    expect(report.counts).toEqual({ better: 2, worse: 0, same: 0 });
    expect(report.incomparable).toBe(1);
    // The geometric mean covers the two comparable rows only.
    expect(report.geomean).toBeCloseTo(Math.sqrt((112.583 / 114.88) * (58 / 70)), 10);
    expect(report.shared).toEqual({ device: "iPhone" });
  });

  it("treats a condition the row varies on purpose as the experiment, not a mismatch", () => {
    const row = compare([
      { name: "Render FPS", before: 58.1, after: 69, better: "higher", varies: "display", contextBefore: { display: "60 Hz" }, contextAfter: { display: "120 Hz" } },
    ]).rows[0];
    expect(row.comparable).toBe(true);
    expect(row.comparability).toMatchObject({ state: "matched", differing: [], varied: [{ key: "display", before: "60 Hz", after: "120 Hz" }] });
  });

  it("calls conditions recorded on one side only partial, still judged", () => {
    const row = compare([{ name: "FPS", before: 113.16, after: 72.9, better: "higher", contextBefore: { display: "120 Hz requested", thermal: "Nominal" }, contextAfter: { thermal: " nominal " } }]).rows[0];
    expect(row.comparable).toBe(true);
    expect(row.comparability).toMatchObject({ state: "partial", oneSided: [{ key: "display", before: "120 Hz requested", after: null }], same: { thermal: "Nominal" } });
    expect(compareContexts(null, null)).toBeNull();
  });

  it("reads repeated values as their mean, with their spread as the noise", () => {
    const row = compare([{ name: "p95 frame time", before: [18.43, 18.49], after: [22.36, "25.01"], unit: "ms" }]).rows[0];
    expect(row.before).toBeCloseTo(18.46, 10);
    expect(row.after).toBeCloseTo(23.685, 10);
    expect(row.beforeSamples).toEqual([18.43, 18.49]);
    expect(row.afterSamples).toEqual([22.36, 25.01]);
    expect(row.noise).toBeCloseTo(Math.abs(22.36 - 25.01) / Math.SQRT2, 10);
    expect(row.verdict).toBe("worse");
    // A spread as wide as the change is noise.
    expect(compare([{ name: "noisy", before: [10, 14], after: [12, 16] }]).rows[0].verdict).toBe("same");
  });

  it("takes a side as {value, context}", () => {
    const row = compare([{ name: "FPS", before: { value: 45.464, context: { thermal: "Serious" } }, after: { mean: 48.849, context: { thermal: "Fair" } }, better: "higher" }]).rows[0];
    expect([row.before, row.after, row.comparable]).toEqual([45.464, 48.849, false]);
  });
});

describe("all runs", () => {
  it("reads the device runs: metrics from the spec, conditions shared and varying, failed runs kept", () => {
    const report = allRuns(fixture("device-runs.json"));
    expect(report.metrics).toEqual([
      { key: "fps", label: "FPS", unit: "fps", better: "higher" },
      { key: "p95", label: "p95 frame time", unit: "ms", better: "lower" },
      { key: "p99", label: "p99 frame interval", unit: "ms", better: "lower" },
      { key: "footprint", label: "Peak footprint", unit: "GB", better: "lower" },
    ]);
    expect(report.runs).toHaveLength(20);
    expect(report.counts).toEqual({ ok: 19, failed: 1, timeout: 0, other: 0 });
    expect(report.shared).toEqual({ device: "iPhone" });
    expect(report.varying).toEqual(["workload", "FPS measure", "display", "thermal"]);
    expect(report.groupBy).toBe("workload");
    const failed = report.runs.find((run) => run.status === "failed");
    expect(failed).toMatchObject({ name: "Relaunch after the live match", statusLabel: null, values: {} });
  });

  it("groups by a condition, best per metric within each group", () => {
    const report = allRuns(fixture("device-runs.json"));
    const cohorts = groupRuns(report, "workload");
    expect(cohorts.map((cohort) => [cohort.value, cohort.runs.length])).toEqual([
      ["Rust replay", 2],
      ["matched replay", 4],
      ["live match, 2 bots", 1],
      ["replay, length not stated", 1],
      ["30 s replay", 4],
      ["10 s replay pair", 2],
      ["2 min live match, 7 bots", 6],
    ]);
    const live = cohorts[6];
    expect(live.best).toEqual({ fps: 49.825, p99: 29.173, footprint: 3.778 });
    // Thermal is recorded for three of the six live runs: their best compares unlike runs.
    expect(live.varying).toEqual(["thermal"]);
    // Equal values have no best: both staging runs measured 16.67 ms.
    expect(cohorts[5].best).toEqual({ fps: 114.88 });
    const all = groupRuns(report, null);
    expect(all).toHaveLength(1);
    expect(all[0].best.fps).toBe(114.88);
    // Runs that do not record the condition form their own group, last.
    const byThermal = groupRuns(report, "thermal");
    expect(byThermal.at(-1)).toMatchObject({ key: "thermal", value: null });
    expect(byThermal.map((cohort) => cohort.value)).toEqual(["Serious", "Nominal", "Fair / serious", "Fair → serious", null]);
  });

  it("reads a hand-written list: units and directions from the keys, status words kept", () => {
    const report = allRuns(
      [
        { name: "a", metrics: { fps: 58, p99_ms: 21.4, "load (s)": 10.07, hit_rate_pct: 64.75, draws: 1655 }, context: { thermal: "Nominal" } },
        { run: "b", status: "crashed", metrics: { fps: 90, p99_ms: null }, note: "Jetsam" },
        { status: "timed_out", metrics: {} },
        { name: "d", status: "thermal_refused", metrics: {} },
        { name: "e", status: "PASS", metrics: { fps: { value: 61, unit: "FPS" }, draws: "1500" } },
        "junk",
      ],
      "ms",
    );
    expect(report.metrics.map((metric) => [metric.key, metric.label, metric.unit, metric.better])).toEqual([
      // A metric's own {unit} beats the key's.
      ["fps", "FPS", "FPS", "higher"],
      ["p99_ms", "p99", "ms", "lower"],
      ["load (s)", "load", "s", "lower"],
      ["hit_rate_pct", "hit rate", "%", "higher"],
      // No unit in the key: the component's unit.
      ["draws", "draws", "ms", "lower"],
    ]);
    expect(report.runs.map((run) => [run.name, run.status, run.statusLabel])).toEqual([
      ["a", "ok", null],
      ["b", "failed", "crashed"],
      ["Run 3", "timeout", "timed out"],
      ["d", "other", "thermal refused"],
      ["e", "ok", null],
    ]);
    expect(report.runs[4].values).toEqual({ fps: 61, draws: 1500 });
    expect(report.ignored).toBe(1);
    expect(unmeasuredCounts(report.runs)).toEqual([
      { word: "crashed", status: "failed", count: 1 },
      { word: "timed out", status: "timeout", count: 1 },
      { word: "thermal refused", status: "other", count: 1 },
    ]);
    // A failed run never wins, even with a value.
    expect(bestValues(report.runs, report.metrics)).toEqual({ fps: 61, draws: 1500 });
  });

  it("is empty for no runs and ignores a groupBy that does not vary", () => {
    expect(allRuns({ runs: [] })).toMatchObject({ runs: [], metrics: [], shared: {}, varying: [], groupBy: null });
    expect(allRuns({ runs: [{ name: "a", metrics: { fps: 1 }, context: { device: "iPhone" } }], groupBy: "device" }).groupBy).toBeNull();
  });
});
