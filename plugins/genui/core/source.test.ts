import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, toMarkdown, type LoadedData, type Program } from "./index";
import type { UiNode } from "./types";

const FILES: Record<string, string> = {
  "sales.csv": "region,total\nEU,120\nUS,80",
  "latency.json": '[{"day": "Mon", "ms": 120}, {"day": "Tue", "ms": 95}]',
  "before.json": "[3, 5]",
  "after.json": "[2, 4]",
  "todo.json": '["Write", "Test"]',
  "$BB_THREAD_STORAGE/audit.json": '{"high": 2, "low": 5}',
};

const DATA = new Map<string, LoadedData>(Object.entries(FILES).map(([path, text]) => [dataKey({ path, raw: false }), parseDataFile(path, text)]));

function program(source: string): Program {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return result.program;
}

function roots(source: string): UiNode[] {
  const compiled = program(source);
  const result = evaluate(compiled, initialState(compiled, DATA), DATA);
  expect(result.diagnostics).toEqual([]);
  return result.roots;
}

const loadedFrom = (source: string) => roots(source).map((root) => root.props.loadedFrom ?? null);
const markdown = (source: string) => toMarkdown(roots(source));

describe("where a component's numbers come from", () => {
  it("finds the file a Table's rows are Loaded from, inside the call", () => {
    expect(loadedFrom('Table(["Region", "Total"], Load("sales.csv").map(r => [r.region, r.total]))')).toEqual([["sales.csv"]]);
  });

  it("follows named values to the Load that defines them", () => {
    const source = 'rows = Load("latency.json")\nms = rows.map(r => r.ms)\nChart("line", rows.map(r => r.day), ms)';
    expect(loadedFrom(source)).toEqual([["latency.json"]]);
  });

  it("follows named functions and $state initializers", () => {
    const source = [
      'slowest = key => max(Load("latency.json").map(r => r[key]))',
      '$tasks = Load("todo.json")',
      'Metric("Slowest day", slowest("ms") + " ms")',
      'Table(["Task"], $tasks.map(t => [t]))',
    ].join("\n");
    expect(loadedFrom(source)).toEqual([["latency.json"], ["todo.json"]]);
  });

  it("lists every file once, in the order the arguments reach them", () => {
    const source = 'before = Load("before.json")\nChart("bar", ["A", "B"], {Before: before, After: Load("after.json"), Again: before})';
    expect(loadedFrom(source)).toEqual([["before.json", "after.json"]]);
  });

  it("does not credit a file for an arrow parameter that shadows its name", () => {
    expect(loadedFrom('rows = Load("sales.csv")\nTable(["N"], [1, 2].map(rows => [rows]))')).toEqual([null]);
  });

  it("does not credit a file the component's data never reaches", () => {
    expect(loadedFrom('total = sum(Load("sales.csv").map(r => r.total))\nMetric("Typed", "200")\nMetric("Loaded", total)')).toEqual([null, ["sales.csv"]]);
  });

  it("lets an explicit source win over the files", () => {
    const [table] = roots('Table(["Region"], Load("sales.csv").map(r => [r.region]), source: "CRM export, 2026-10-01")');
    expect(table.props.source).toBe("CRM export, 2026-10-01");
    expect(table.props.loadedFrom).toBeUndefined();
  });
});

describe("source captions in markdown", () => {
  it("puts the loaded file under a Table or Chart", () => {
    expect(markdown('Table(["Region", "Total"], Load("sales.csv").map(r => [r.region, r.total]))')).toBe(
      "| Region | Total |\n| --- | --- |\n| EU | 120 |\n| US | 80 |\n\nSource: `sales.csv`",
    );
    expect(markdown('Chart("bar", ["A", "B"], {Before: Load("before.json"), After: Load("after.json")})')).toMatch(
      /\n\nSource: `before.json`, `after.json`$/,
    );
  });

  it("names a thread-storage file by its name", () => {
    expect(markdown('Metric("High", Load("$BB_THREAD_STORAGE/audit.json").high, tone: "bad")')).toBe("High **2** — Source: `audit.json`");
  });

  it("writes an explicit source as given, and an https one as a link", () => {
    expect(markdown('Metric("Users", "1.2M", "monthly", source: "illustrative")')).toBe("Users **1.2M** (monthly) — Source: illustrative");
    expect(markdown('Chart("bar", ["Q1"], [4], source: "https://www.example.com/report/q1")')).toMatch(
      /\n\nSource: \[example\.com\/report\/q1\]\(https:\/\/www\.example\.com\/report\/q1\)$/,
    );
  });

  it("names a source the Metrics of a Row share once, and each one's own otherwise", () => {
    const shared = 'audit = Load("$BB_THREAD_STORAGE/audit.json")\nRow([Metric("High", audit.high), Metric("Low", audit.low)])';
    expect(markdown(shared)).toBe("High **2** · Low **5** — Source: `audit.json`");
    const mixed = 'Row([Metric("High", Load("$BB_THREAD_STORAGE/audit.json").high), Metric("Goal", "0", source: "team target")])';
    expect(markdown(mixed)).toBe("High **2** — Source: `audit.json` · Goal **0** — Source: team target");
  });

  it("captions a Table once, not each component in its cells", () => {
    expect(markdown('Table(["Region", "Total"], Load("sales.csv").map(r => [r.region, Metric("Total", r.total)]))')).toBe(
      "| Region | Total |\n| --- | --- |\n| EU | Total **120** |\n| US | Total **80** |\n\nSource: `sales.csv`",
    );
  });

  it("adds nothing to typed numbers without a source", () => {
    expect(markdown('Row([Metric("A", "1"), Metric("B", "2")])\nTable(["X"], [[1]])')).toBe("A **1** · B **2**\n\n| X |\n| --- |\n| 1 |");
  });
});
