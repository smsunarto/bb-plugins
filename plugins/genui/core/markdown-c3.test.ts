import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, toMarkdown } from "./index";

function gallery(name: string): string {
  return readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8");
}

function markdown(source: string, files: Record<string, string> = {}): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map(Object.entries(files).map(([path, text]) => [dataKey({ path, raw: false }), parseDataFile(path, text)]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

describe("toMarkdown: Pipeline", () => {
  it("renders a gh run: header, counts, jobs by stage with the failing step", () => {
    const out = markdown(`Pipeline(Load("run.json"))`, { "run.json": gallery("gh-run-failed.json") });
    const job = (id: string) => `https://github.com/vitejs/vite/actions/runs/37986166856/job/${id}`;
    expect(out.split("\n\n").slice(0, 2)).toEqual([
      "**[fix(css): don't propagate rejections to later tasks in `createSerialPromiseQueue`](https://github.com/vitejs/vite/actions/runs/37986166856)** — 🔴 Failed · CI · `fix/serial-promise-queue-rejection` @ `05edab7` · pull request · 8m 12s\n10 jobs: 1 failed · 8 passed · 1 skipped",
      `🟢 **Stage 1** (2 jobs · 1m 34s):\n- 🟢 [Get changed files](${job("114009217894")}) — 9s\n- 🟢 [Lint: node-24, ubuntu-latest](${job("114009218359")}) — 1m 34s`,
    ]);
    // The matrix says its name once, its failed job first with the step that failed.
    expect(out).toContain(
      `🔴 **Build&Test** (6 jobs · 6m 11s):\n- 🔴 [node-24, macos-latest](${job("114009293942")}) — 5m 53s — failed at step 14 "Test build" (1m 25s)\n- 🟢 [node-24, ubuntu-latest]`,
    );
    expect(out).toContain("🟢 **Stage 3** (2 jobs · 6s):\n- 🟢 [Build & Test Failed]");
  });

  it("renders a pull request's checks by workflow, its runs apart", () => {
    const out = markdown(`Pipeline(Load("checks.json"))`, { "checks.json": gallery("gh-pr-checks.json") });
    expect(out.startsWith("**Checks** — 🔴 Failed · 8m 06s\n30 checks: 4 failed · 20 passed · 3 neutral · 3 skipped")).toBe(true);
    expect(out).toContain("🔴 **CI · run 2 of 2** (10 checks · 8m 01s):\n- 🔴 [Build&Test: node-26, ubuntu-latest]");
    expect(out).toContain("🟢 **Other checks** (6 checks · 43s):\n- 🟢 [CodeQL](https://github.com/vitejs/vite/runs/113918603301) — 3s");
    // A check without times (netlify's) has no duration; a group of one check named as its workflow is one line.
    expect(out).toContain("- 🟢 [netlify/vite-docs-main/deploy-preview](https://app.netlify.com/projects/vite-docs-main/deploys/6ac91660817d3600085bb188)\n");
    expect(out).toContain("\n\n- 🟢 [Semantic Pull Request](https://github.com/vitejs/vite/actions/runs/37959473446/job/113918333411) — 5s\n\n");
  });

  it("renders a running run with the step it is at", () => {
    const out = markdown(`Pipeline(Load("run.json"))`, { "run.json": gallery("gh-run-running.json") });
    expect(out).toContain("— 🟡 In progress · build-and-deploy · `codex/turbopack-node-ipc-linear-parse` @ `22ae8a3` · pull request\n6 jobs: 1 running · 5 passed");
    expect(out).toContain('— running 1m 01s — at "Build Docker builder image"');
  });

  it("renders a hand-written list: single-job stages as plain lines, a step's message under its job", () => {
    const source = `Pipeline([
      {name: "Build", status: "passed", duration: 72},
      {name: "Test", status: "failed", jobs: [
        {name: "e2e", status: "failed", duration: "4m", steps: [{name: "Run playwright", status: "failed", message: "3 failed"}]},
        {name: "unit", status: "passed", duration: "2m 10s"}
      ]},
      {name: "Deploy", status: "skipped"}
    ])`;
    expect(markdown(source)).toBe(
      [
        "**Pipeline** — 🔴 Failed\n4 jobs: 1 failed · 2 passed · 1 skipped",
        "- 🟢 Build — 1m 12s",
        '🔴 **Test** (2 jobs · 4m 00s):\n- 🔴 e2e — 4m 00s — failed at step 1 "Run playwright"\n  3 failed\n- 🟢 unit — 2m 10s',
        "- ⚪ Deploy",
      ].join("\n\n"),
    );
  });

  it("says what is wrong with unusable input and when there is nothing", () => {
    expect(markdown(`Pipeline("CI")`)).toMatch(/^_\(Pipeline needs gh run view/);
    expect(markdown(`Pipeline([])`)).toBe("**Pipeline** — ⚪ Neutral\n\nNo jobs.");
  });
});

describe("toMarkdown: Dependencies", () => {
  it("renders npm outdated by bump with the changed part in bold and wanted between", () => {
    const out = markdown(`Dependencies(Load("outdated.json"))`, { "outdated.json": gallery("npm-outdated.json") });
    expect(out.startsWith("**Outdated** — npm outdated: 18 packages (13 major · 3 minor · 1 patch · 1 not installed)\n\nMajor (13):\n- `@types/node` 20.19.43 → **26.6.5** (dev)")).toBe(true);
    expect(out).toContain("- `express` 4.17.1 → 4.**22.3** (wanted) → **5.3.0**");
    expect(out).toContain("Minor (3):\n- `lodash` 4.17.15 → 4.**18.1**");
    expect(out).toContain("Patch (1):\n- `minimist` 1.2.5 → 1.2.**8**");
    expect(out.endsWith("Not installed (1):\n- `dayjs` — not installed (wants 1.11.23)")).toBe(true);
  });

  it("renders npm audit: the severity strip, then each package with its advisory and fix", () => {
    const out = markdown(`Dependencies(Load("audit.json"))`, { "audit.json": gallery("npm-audit.json") });
    expect(out.startsWith("**Vulnerabilities** — npm audit: 🔴 4 critical · 🔴 9 high · 🟠 4 moderate · ⚪ 3 low (311 dependencies scanned)")).toBe(true);
    expect(out).toContain(
      "- 🔴 **critical** `minimist` 1.0.0 - 1.2.5 — direct — [Prototype Pollution in minimist](https://github.com/advisories/GHSA-xvch-5gv4-984h) — fix: minimist 1.2.8",
    );
    expect(out).toContain("- 🟠 **moderate** `uuid` <11.1.1 — direct — [uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — fix: uuid 14.0.2 (semver-major)");
    expect(out).toContain("- 🟠 **moderate** `vite-node` <=2.2.0-beta.2 — transitive — through vite — fix: vitest 1.6.1");
    expect(out).not.toContain("**Outdated**");
  });

  it("renders pip and a hand list, and an up-to-date project", () => {
    const pip = markdown(`Dependencies(Load("pip.json"))`, { "pip.json": gallery("pip-outdated.json") });
    expect(pip).toContain("**Outdated** — pip list --outdated:");
    expect(pip).toContain("- `idna` 2.10 → **3.20**");
    expect(markdown(`Dependencies([{name: "next", current: "15.0.0-rc.0", latest: "15.0.0", severity: "high", note: "fixes the advisory"}])`)).toBe(
      [
        "**Vulnerabilities**: 🔴 1 high",
        "- 🔴 **high** `next` — fixes the advisory — fix: next 15.0.0",
        "**Outdated**: 1 package (1 pre-release)",
        "Pre-release (1):\n- `next` 15.0.0-rc.0 → 15.0.0 (high) — fixes the advisory",
      ].join("\n\n"),
    );
    expect(markdown(`Dependencies({})`)).toBe("**Dependencies** — every dependency is on its latest version.");
    expect(markdown(`Dependencies(42)`)).toMatch(/^_\(Dependencies needs npm outdated/);
  });
});
