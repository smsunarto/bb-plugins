import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dataKey, type LoadedData } from "./data";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import type { Value } from "./types";

function markdown(source: string, files: Record<string, Value> = {}): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map<string, LoadedData>(Object.entries(files).map(([path, value]) => [dataKey({ path, raw: false }), { ok: true, value } as LoadedData]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

const fixture = (name: string): Value => JSON.parse(readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8")) as Value;

// The fallback reads today from the clock; every case here runs on 2026-10-10 at noon.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 10, 12, 0));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("toMarkdown: Board", () => {
  it("lists a written board per column in workflow order, late due dates in bold", () => {
    expect(
      markdown(`Board([
  {key: "LCH-31", title: "Pricing page", status: "in_progress", priority: "high", labels: ["web"], owner: "Marta Rossi", due: "2026-10-14", agentsWorking: 2},
  {key: "LCH-25", title: "Press kit", status: "In Progress", owner: "Ana Lima", due: "2026-10-07"},
  {title: "Status page", status: "todo", url: "https://status.example.com/plan"},
  {title: "Brand refresh", status: "done", due: "2026-10-01"}
])`),
    ).toBe(`**Board** · 4 items

**Todo** (1)
- [Status page](https://status.example.com/plan)

**In progress** (2)
- \`LCH-31\` Pricing page · high · Marta Rossi · web · due Oct 14 · 🟢 2 agents working
- \`LCH-25\` Press kit · Ana Lima · **due Oct 7 (3 days late)**

**Done** (1)
- Brand refresh · due Oct 1`);
  });

  it("shows the columns asked for, empty ones too, and says what it left out", () => {
    expect(markdown(`Board([{title: "A", status: "todo"}, {title: "B", status: "blocked"}], ["Todo", "Done"])`)).toBe(`**Board** · 1 item · 1 in other columns not shown

**Todo** (1)
- A

**Done** (0)
_none_`);
  });

  it("reads bb tasks list --json with keys, priorities and sub-tasks", () => {
    const out = markdown(`Board(Load("tasks.json"))`, { "tasks.json": fixture("bb-tasks-orb.json") });
    expect(out.split("\n")[0]).toBe("**Tasks** · 23 tasks");
    expect(out).toContain("**Backlog** (13)");
    expect(out).toContain("**In progress** (6)");
    expect(out).toContain("**Done** (4)");
    expect(out).toMatch(/^- `ORB-9` GitHub #411 .* · high · sub-task of ORB-\d+$/m);
  });

  it("reads gh issue list --json as linked issues per state", () => {
    const out = markdown(`Board(Load("issues.json"))`, { "issues.json": fixture("gh-issues-nextjs.json") });
    expect(out.split("\n")[0]).toBe("**Issues** · 20 issues");
    expect(out).toContain("**Open** (16)");
    expect(out).toContain("**Closed** (4)");
    expect(out).toContain(
      "- `#99954` [Turbopack keeps unused exports of a namespace reached through another namespace (`lib.core.X`)](https://github.com/vercel/next.js/issues/99954) · Performance, Turbopack",
    );
  });

  it("folds long columns and says why an unusable input shows nothing", () => {
    const many = Array.from({ length: 23 }, (_, index) => `{title: "Task ${index + 1}", status: "todo"}`).join(", ");
    const out = markdown(`Board([${many}])`);
    expect(out).toContain("- Task 20\n_… and 3 more items_");
    expect(markdown(`Board("nope")`)).toBe("_(Board needs a list of {title, status?} items, bb tasks list --json ({tasks: […]}) or gh issue/pr list --json)_");
  });
});

describe("toMarkdown: Roadmap", () => {
  it("lists each lane with ranges, status, progress, owners, dependencies and late items", () => {
    expect(
      markdown(`Roadmap([
  {title: "Design", start: "2026-09-21", end: "2026-10-02", lane: "Product", status: "done", owner: "Ana"},
  {title: "Build", start: "2026-10-01", days: 20, lane: "Product", progress: 40, after: "Design"},
  {title: "Press kit", start: "2026-09-28", end: "2026-10-08", lane: "Marketing", status: "active", progress: 60},
  {title: "Launch", milestone: "2026-10-28", lane: "Marketing", after: "Build"},
  {title: "Undated", lane: "Marketing"}
])`),
    ).toBe(`**Roadmap** · Sep 21 – Oct 28 · 4 items · 1 late

**Product**
- ✅ Design — Sep 21 – Oct 2 (12 days) · done · Ana
- 🔵 Build — Oct 1 – Oct 20 (20 days) · active · 40% · after Design (overlaps it)

**Marketing**
- 🔵 Press kit — Sep 28 – Oct 8 (11 days) · active · 60% · **late: ended Oct 8**
- ◆ Launch — Oct 28 (milestone) · after Build

_Left out (no usable dates): Undated (no start date (yyyy-mm-dd))_`);
  });

  it("says when nothing has usable dates", () => {
    expect(markdown(`Roadmap([{title: "Someday"}])`)).toBe("_(No roadmap item has usable dates: Someday has no start date (yyyy-mm-dd))_");
    expect(markdown(`Roadmap([])`)).toBe("**Roadmap** · no items");
  });
});

describe("toMarkdown: Status", () => {
  it("lists items worst first with relative due dates and notes", () => {
    expect(
      markdown(`Status([
  {name: "Website", status: "on-track", progress: 70, owner: "Marta", due: "2026-10-16", note: "Pricing in review"},
  {name: "Press kit", status: "off-track", progress: 60, owner: "Ana", due: "2026-10-08", note: "Photos missing.\\nAgency deadline passed."},
  {name: "Billing", status: "done", due: "2026-10-09"},
  {name: "Onboarding", status: "at-risk", due: "2026-10-11"}
])`),
    ).toBe(`**Status** · 1 on track · 1 at risk · 1 off track · 1 done

- 🔴 **Press kit** — Off track · 60% · Ana · **2 days late**
  Photos missing.
  Agency deadline passed.
- 🟠 **Onboarding** — At risk · due tomorrow (Oct 11)
- 🟢 **Website** — On track · 70% · Marta · in 6 days (Oct 16)
  Pricing in review
- ✅ **Billing** — Done · Oct 9`);
  });

  it("keeps unknown statuses as written and reads empty input honestly", () => {
    expect(markdown(`Status([{name: "Legal", status: "pending counsel"}])`)).toBe("**Status** · 1 other\n\n- ⚪ **Legal** — pending counsel");
    expect(markdown(`Status([])`)).toBe("**Status** · nothing to report");
  });
});
