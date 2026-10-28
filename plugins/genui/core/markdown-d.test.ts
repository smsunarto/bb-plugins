import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";

function markdown(source: string): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return toMarkdown(evaluate(result.program, initialState(result.program)).roots);
}

describe("toMarkdown: charts and meters", () => {
  it("scatter is a table of x against each series", () => {
    expect(markdown('Chart("scatter", [1, 2.5], {a: [3, null], b: [4, 5]}, unit: "ms")')).toBe(
      "| x | a (ms) | b (ms) |\n| --- | --- | --- |\n| 1 | 3 | 4 |\n| 2.5 |  | 5 |",
    );
  });

  it("radar is one row per axis and never gets a stacked total", () => {
    expect(markdown('Chart("radar", ["Speed", "Range", "Price"], {A: [8, 6, 4], B: [5, 9, 7]}, stacked: true)')).toBe(
      "|  | A | B |\n| --- | --- | --- |\n| Speed | 8 | 5 |\n| Range | 6 | 9 |\n| Price | 4 | 7 |",
    );
  });

  it("funnel shows each stage against the first and the one before", () => {
    expect(markdown('Chart("funnel", ["Visits", "Sign-ups", "Paid"], [1000, 400, 30])')).toBe(
      [
        "|  | Value | % of first | % of previous |",
        "| --- | --- | --- | --- |",
        "| Visits | 1000 |  |  |",
        "| Sign-ups | 400 | 40% | 40% |",
        "| Paid | 30 | 3% | 7.5% |",
      ].join("\n"),
    );
  });

  it("heatmap keeps the labels across and a row per series, unit in the corner", () => {
    expect(markdown('Chart("heatmap", ["Mon", "Tue"], {AM: [1, 2], PM: [3]}, unit: "h")')).toBe(
      "| h | Mon | Tue |\n| --- | --- | --- |\n| AM | 1 | 2 |\n| PM | 3 |  |",
    );
  });

  it("histogram is a range/count table per group, and says what it left out", () => {
    expect(markdown('Chart("histogram", [0, 10, 20], {a: [1, 10, 20, 25], b: [5, null]}, unit: "ms")')).toBe(
      "| Range (ms) | a | b |\n| --- | --- | --- |\n| 0–10 | 1 | 1 |\n| 10–20 | 2 | 0 |\n\n_1 empty or non-numeric value and 1 outside the bins left out_",
    );
    expect(markdown('Chart("histogram", [], [5, 5])')).toBe("| Range | Count |\n| --- | --- |\n| 4.5–5.5 | 2 |");
    expect(markdown('Chart("histogram", ["low", "high"], [1])')).toBe("_A histogram's labels are its bin edges: ascending numbers, or [] for automatic bins_");
  });

  it("box is a five-number summary per group with its outliers; a lone series takes the first label as its name", () => {
    expect(markdown('Chart("box", [], {api: [1, 2, 3, 4, 100], db: []}, unit: "ms")')).toBe(
      "| (ms) | n | min | Q1 | median | Q3 | max | outliers |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| api | 5 | 1 | 2 | 3 | 4 | 100 | 100 |\n| db | 0 |  |  |  |  |  |  |",
    );
    expect(markdown('Chart("box", ["runs"], [3, 1, 2])')).toContain("| runs | 3 | 1 | 1.5 | 2 | 2.5 | 3 |  |");
  });

  it("reads a series written with its own tone", () => {
    expect(markdown('Chart("bar", ["Mon", "Tue"], {ok: {values: [3, 4], tone: "good"}, failed: [1, null]})')).toBe(
      "|  | ok | failed |\n| --- | --- | --- |\n| Mon | 3 | 1 |\n| Tue | 4 |  |",
    );
  });

  it("Gauge reads its value and range, max defaulting to 100", () => {
    expect(markdown('Gauge(72, label: "CPU")')).toBe("CPU: **72** (0–100)");
    expect(markdown("Gauge(3, min: 1, max: 5)")).toBe("**3** (1–5)");
  });

  it("SegmentedBar is a table of parts with shares that never hide a sliver", () => {
    expect(
      markdown('SegmentedBar([{label: "Done", value: 999, tone: "good"}, {label: "Left", value: 1}, {label: "Bad", value: -1}], unit: "h")'),
    ).toBe("|  | Value (h) | % |\n| --- | --- | --- |\n| 🟢 Done | 999 | 100% |\n| Left | 1 | <1% |");
  });

  it("CalendarHeatmap lists a short range day by day, adding repeated dates", () => {
    expect(
      markdown('CalendarHeatmap([{date: "2026-03-02", value: 2}, {date: "2026-03-01", value: 1}, {date: "2026-03-02", value: 3}, {date: "nope", value: 9}], label: "Runs")'),
    ).toBe(
      "Runs: **6** total, 2026-03-01 to 2026-03-02; busiest 2026-03-02 (5)\n\n| Date | Runs |\n| --- | --- |\n| 2026-03-01 | 1 |\n| 2026-03-02 | 5 |",
    );
  });

  it("CalendarHeatmap folds a long range into months", () => {
    const days = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 0, 20 + index)).toISOString().slice(0, 10);
        return [date, index % 5];
      }),
    );
    const out = markdown(`CalendarHeatmap(${JSON.stringify(days)})`);
    expect(out).toContain("**80** total, 2026-01-20 to 2026-02-28; busiest 2026-01-24 (4)");
    expect(out).toContain("| Jan 2026 | 21 | 9 | 2026-01-24 (4) |\n| Feb 2026 | 59 | 23 | 2026-02-03 (4) |");
  });
});
