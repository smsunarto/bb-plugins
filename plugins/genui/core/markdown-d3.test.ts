import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataKey, parseDataFile, type LoadedData } from "./data";
import { specToMarkdown } from "./markdown";

/** The markdown of `source` with `files` (gallery/data names) loaded as Load reads them. */
function markdown(source: string, ...files: string[]): string {
  const data = new Map<string, LoadedData>();
  for (const file of files) {
    const path = `data/${file}`;
    data.set(dataKey({ path, raw: false }), parseDataFile(path, readFileSync(new URL(`../gallery/${path}`, import.meta.url), "utf8")));
  }
  return specToMarkdown(source, data);
}

describe("toMarkdown: Benchmark", () => {
  it("is a table of before, after and the change with its verdict", () => {
    expect(
      markdown(`Benchmark([
        {name: "Cold start", before: 412, after: 298, unit: "ms"},
        {name: "Throughput", before: 1840, after: 2310, unit: "req/s", better: "higher"},
        {name: "Peak memory", before: 212, after: 213, unit: "MB"}
      ])`),
    ).toBe(
      [
        "**Benchmark** · 2 better · 1 within noise · 16.7% better overall (geometric mean)",
        "",
        "|  | Before | After | Change |",
        "| --- | --- | --- | --- |",
        "| Cold start | 412 ms | 298 ms | 🟢 −27.7% (−114 ms) |",
        "| Throughput (higher is better) | 1,840 req/s | 2,310 req/s | 🟢 +25.5% (+470 req/s) |",
        "| Peak memory | 212 MB | 213 MB | ⚪ +0.5% (+1 MB) |",
      ].join("\n"),
    );
  });

  it("ranks hyperfine commands with hyperfine's ratios", () => {
    expect(markdown('Benchmark(Load("data/hyperfine-startup.json"))', "hyperfine-startup.json")).toBe(
      [
        "**Benchmark** · `bun -e 0` is fastest: 3.92 ± 0.44 × faster than `python3 -c 0`, 4.62 ± 0.73 × faster than `node -e 0`",
        "",
        "1. `bun -e 0` — 7.8 ms ± 0.75 ms (7.05 ms … 10.3 ms) · fastest",
        "2. `python3 -c 0` — 30.5 ms ± 1.8 ms (28.4 ms … 34.7 ms) · 3.92 ± 0.44 × slower",
        "3. `node -e 0` — 36 ms ± 4.6 ms (31.2 ms … 48.3 ms) · 4.62 ± 0.73 × slower",
      ].join("\n"),
    );
  });

  it("gives each vitest bench group its own ranking", () => {
    const text = markdown('Benchmark(Load("data/vitest-bench.json"))', "vitest-bench.json");
    expect(text).toContain("**compile a spec** · `compileStreaming` is fastest: 1.07 ± 0.01 × faster than `compile`");
    expect(text).toContain("2. `compile` — 27.7 µs ± 43 µs (23.6 µs … 5.58 ms) · 1.07 ± 0.01 × slower");
    expect(text).toContain("**parse a data file** · `HAR as JSON` is fastest: 3.60 ± 0.01 × faster than `500-row CSV`");
    expect(text).toContain("2. `500-row CSV` — 209 µs");
  });

  it("says what it needs for unusable input", () => {
    expect(markdown('Benchmark("fast")')).toBe(
      "_(Benchmark needs [{name, before, after}], hyperfine --export-json or vitest bench --outputJson output)_",
    );
  });
});

describe("toMarkdown: Waterfall", () => {
  it("lists nested spans with their times and marks the critical path", () => {
    expect(
      markdown(`Waterfall([
        {name: "GET /checkout", start: 0, duration: 420},
        {name: "auth", start: 5, duration: 30, depth: 1},
        {name: "render", start: 40, duration: 370, depth: 1, detail: "SSR"}
      ])`),
    ).toBe(
      [
        "**Waterfall** · 3 spans · 420 ms · critical path 400 ms (◆)",
        "",
        "- `GET /checkout` · 0 ms → 420 ms (420 ms) ◆",
        "  - `auth` · 5 ms → 35 ms (30 ms) ◆",
        "  - `render` · 40 ms → 410 ms (370 ms) · SSR ◆",
      ].join("\n"),
    );
  });

  it("shows a HAR's requests with status, size and the failure", () => {
    const text = markdown('Waterfall(Load("data/python-org.har"))', "python-org.har");
    expect(text.split("\n")[0]).toMatch(/^\*\*Waterfall\*\* · 29 requests · \d+ ms · 1 failed · critical path \d+ ms \(◆\) · DOMContentLoaded \d+ ms · Load \d+ ms$/);
    expect(text).toContain("\n- `www.python.org/` 200 · 2 ms → 226 ms (224 ms) · 11.8 KB\n- `jquery-ui.min.js (ajax.googleapis.com)` 200 ·");
    expect(text).toContain("- 🔴 `script.file-downloads.outbound-links.js (analytics.python.org)` net::ERR_BLOCKED_BY_CLIENT.Inspector ·");
  });

  it("nests a trace's events under their thread", () => {
    const text = markdown('Waterfall(Load("data/python-org-trace.json"))', "python-org-trace.json");
    expect(text).toMatch(/^\*\*Waterfall\*\* · 29 events · 23 ms · /);
    expect(text).toContain("\n- `CrRendererMain` · 0 ms → 23 ms (23 ms) · 27 events ◆");
    expect(text).toContain("\n  - `ParseHTML` · 3.94 ms → 7.05 ms (3.1 ms) · https://www.python.org/ ◆");
    expect(text).toContain("\n- `ThreadPoolForegroundWorker #2` · ");
  });
});

describe("toMarkdown: Treemap", () => {
  it("lists groups largest first with size and share", () => {
    expect(
      markdown(`Treemap([
        {path: "src/app.ts", bytes: 3000},
        {path: "src/lib/a.ts", bytes: 1000},
        {path: "README.md", bytes: 1000}
      ])`),
    ).toBe(
      ["**Treemap** · 4.88 KB · 2 items", "", "- src — 3.91 KB (80%)", "  - app.ts — 2.93 KB (60%)", "  - lib — 1,000 B (20%)", "- README.md — 1,000 B (20%)"].join("\n"),
    );
  });

  it("groups an esbuild metafile's node_modules by package", () => {
    const text = markdown('Treemap(Load("data/esbuild-meta.json"))', "esbuild-meta.json");
    expect(text.split("\n")[0]).toMatch(/^\*\*Treemap\*\* · \d+ KB · 6 items$/);
    expect(text).toMatch(/\n- node_modules — \d+ KB \(\d+%\)\n {2}- sonner — /);
  });

  it("starts du output at its one top directory", () => {
    const text = markdown('Treemap(Load("data/du-node-modules.txt"))', "du-node-modules.txt");
    expect(text.split("\n")[0]).toBe("**Treemap** · node_modules · 158 MB · 149 items");
    expect(text).toContain("\n- typescript — 22.8 MB (14%)\n  - lib — 22.8 MB (14%)");
    expect(text).toContain("_… and 134 more items_");
  });

  it("takes any unit word for nested trees", () => {
    expect(markdown('Treemap([{name: "Compute", children: [{name: "EC2", size: 900}, {name: "Lambda", size: 100}]}], "$")')).toBe(
      ["**Treemap** · Compute · $1,000 · 2 items", "", "- EC2 — $900 (90%)", "- Lambda — $100 (10%)"].join("\n"),
    );
  });
});
