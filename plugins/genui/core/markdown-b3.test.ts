import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, toMarkdown } from "./index";

function markdown(source: string, files: Record<string, string> = {}): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map(Object.entries(files).map(([path, text]) => [dataKey({ path, raw: false }), parseDataFile(path, text)]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

const gallery = (name: string) => readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8");

describe("toMarkdown: Findings", () => {
  it("lists a hand-written review as file:line severity title, most severe first", () => {
    const source = `Findings([
      {severity: "low", title: "Unused option", file: "src/map.ts", line: 88},
      {severity: "critical", title: "Path read without confinement", file: "src/report.py", line: 48, rule: "path-traversal"},
      {severity: "medium", title: "Loose equality", file: "src/map.ts", line: 72, column: 59, rule: "eqeqeq", url: "https://eslint.org/docs/latest/rules/eqeqeq"},
      {severity: "info", title: "Cache the parsed report"}
    ], "Review")`;
    expect(markdown(source)).toBe(`**Review** — 🔴 1 critical · 🟠 1 medium · 🔵 1 low · ⚪ 1 info

- \`src/report.py:48\` critical: Path read without confinement (\`path-traversal\`)
- \`src/map.ts:72:59\` medium: Loose equality ([eqeqeq](https://eslint.org/docs/latest/rules/eqeqeq))
- \`src/map.ts:88\` low: Unused option
- info: Cache the parsed report`);
  });

  it("reads tsc output with the tool's words and keeps code spans in messages", () => {
    const out = markdown(`Findings(Load("tsc.txt"))`, { "tsc.txt": gallery("tsc.txt") });
    expect(out.split("\n\n")[0]).toBe("**3 findings** — 🔴 3 errors — tsc");
    expect(out).toContain("- `data/src/json-logic.ts:49:52` error: Type 'number' is not assignable to type 'string'. (`TS2322`)");
    const ruff = markdown(`Findings(Load("ruff.json"))`, { "ruff.json": gallery("ruff.json") });
    expect(ruff).toContain("error: `os` imported but unused ([F401](https://docs.astral.sh/ruff/rules/unused-import))");
  });

  it("says when there is nothing, and cuts long lists", () => {
    expect(markdown(`Findings(Load("tsc.txt"), "Types")`, { "tsc.txt": "" })).toBe("**Types** — No findings. — tsc");
    const many = Array.from({ length: 60 }, (_, index) => `{severity: "warning", title: "w${index}", file: "a.ts", line: ${index + 1}}`).join(",");
    const out = markdown(`Findings([${many}])`);
    expect(out).toContain("- `a.ts:50` warning: w49");
    expect(out).not.toContain("w50");
    expect(out.endsWith("_… and 10 more findings_")).toBe(true);
  });

  it("escapes markdown in titles outside code spans", () => {
    expect(markdown(`Findings([{severity: "high", title: "Don't use __proto__ in \`a_b\`"}])`)).toContain("high: Don't use \\_\\_proto\\_\\_ in `a_b`");
  });

  it("shows why input is unusable", () => {
    expect(markdown(`Findings(42)`)).toMatch(/^_\(Findings needs/);
  });
});

describe("toMarkdown: Coverage", () => {
  it("renders lcov as the total with its tone and the files with uncovered ranges, most first", () => {
    expect(markdown(`Coverage(Load("lcov.info"))`, { "lcov.info": gallery("lcov.info") })).toBe(`**Coverage** — 🔴 **38.3%** of lines (41 of 107) · branches 21.5% · functions 54.5%

| File | Lines | Uncovered lines |
| --- | --- | --- |
| \`data/src/json-logic.ts\` | 20.7% | 46: 24–28, 44–52, 59–155 |
| \`data/src/mapMath.ts\` | 59.2% | 20: 66–74, 89–103 |`);
  });

  it("renders a Go profile in statements and a coverage summary with its absolute paths shortened", () => {
    const go = markdown(`Coverage(Load("coverage.out"))`, { "coverage.out": gallery("coverage.out") });
    expect(go.split("\n")[0]).toBe("**Coverage** — 🟠 **74.2%** of statements (23 of 31)");
    expect(go).toContain("| `data/src/semver/bump.go` | 74.2% | 8: 28–29, 44–45, 54, 66–72 |");
    const summary = markdown(`Coverage(Load("coverage-summary.json"))`, { "coverage-summary.json": gallery("coverage-summary.json") });
    expect(summary.split("\n")[0]).toBe("**Coverage** — 🟢 **93.2%** of lines (2,474 of 2,654) · statements 90.7% · branches 84.4% · functions 95.7%");
    expect(summary).toContain("| `core/markdown.ts` |");
    expect(summary).toMatch(/_\d+ more files fully covered_$/);
  });

  it("shows why input is unusable", () => {
    expect(markdown(`Coverage("hello")`)).toMatch(/^_\(Coverage needs/);
  });
});
