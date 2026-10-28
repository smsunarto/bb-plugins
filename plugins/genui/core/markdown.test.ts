import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, specToMarkdown, toMarkdown } from "./index";
import type { UiState, Value } from "./types";

const EXAMPLE = `$seats = 10
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Monthly estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Row([Metric("Per seat", "$" + price), Metric("Total", "$" + fmt(price * $seats), tone: "good")]),
  Button("Go with " + $plan, Send("Let's go with " + $plan + " for " + $seats + " seats"))
])`;

function markdown(source: string, state?: UiState): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return toMarkdown(evaluate(result.program, state ?? initialState(result.program)).roots);
}

describe("toMarkdown", () => {
  it("renders the instructions example with current state values", () => {
    expect(markdown(EXAMPLE)).toBe(`**Monthly estimate**

Plan: Pro (Basic, Pro)

Seats: 10 (1–50)

Per seat **$29** · Total **$290**

Options: Go with Pro`);
    expect(markdown(EXAMPLE, { seats: 20, plan: "Basic" })).toContain("Seats: 20 (1–50)\n\nPer seat **$12** · Total **$240**");
  });

  it("renders tables with badge cells and charts as GFM tables", () => {
    expect(
      markdown(`Card("Services", [
  Table(["Service", "Status", "Notes"], [
    ["api", Badge("healthy", tone: "good"), "p99 | 120ms"],
    ["worker", Badge("degraded", tone: "warn"), "queue\\nbacklog"],
    ["db", Badge("down", tone: "bad"), null]
  ]),
  Chart("bar", ["Mon", "Tue"], {api: [120, 95], worker: [300, null]}, unit: "ms")
])`),
    ).toBe(`**Services**

| Service | Status | Notes |
| --- | --- | --- |
| api | 🟢 healthy | p99 \\| 120ms |
| worker | 🟠 degraded | queue backlog |
| db | 🔴 down |  |

|  | api (ms) | worker (ms) |
| --- | --- | --- |
| Mon | 120 | 300 |
| Tue | 95 |  |`);
  });

  it("renders a plain series chart and standalone badges", () => {
    expect(markdown('Chart("line", ["Q1", "Q2"], [1, 2])\nBadge("new")\nBadge("fyi", tone: "info")')).toBe(
      "|  | Value |\n| --- | --- |\n| Q1 | 1 |\n| Q2 | 2 |\n\n⚪ new\n\n🔵 fyi",
    );
  });

  it("renders progress, steps and tabs", () => {
    expect(
      markdown(`Progress(3, 8, label: "Tasks")
Progress(40)
Steps([{title: "Design", status: "done"}, {title: "Build", detail: "API first", status: "current"}, {title: "Ship", status: "blocked"}, "Announce"])
Tabs(["Summary", "Risks"], [Text("Ships **Friday**"), Text("None")])`),
    ).toBe(`Tasks: 3/8 (38%)

40%

1. ✅ Design
2. ▶️ Build — API first
3. ⛔ Ship
4. Announce

**Summary**

Ships **Friday**

**Risks**

None`);
  });

  it("renders code, diffs and files", () => {
    expect(markdown('Code("const a = `x`", language: "ts")\nDiff("-a\\n+b")\nFile("src/app.ts", line: 12)\nFile("README.md")')).toBe(
      "```ts\nconst a = `x`\n```\n\n```diff\n-a\n+b\n```\n\n`src/app.ts:12`\n\n`README.md`",
    );
    expect(markdown('Code("```\\nnested\\n```")')).toBe("````\n```\nnested\n```\n````");
  });

  it("renders inputs as their current values", () => {
    expect(
      markdown(`$tags = ["api"]
$on = true
$name = ""
$size = "M"
Checklist($tags, ["api", "web"], label: "Areas")
Toggle($on, "Notify")
Input($name, label: "Name")
Select($size, ["S", "M", "L"])`),
    ).toBe(`Areas:
- [x] api
- [ ] web

Notify: on

Name: —

Size: M (S, M, L)`);
  });

  it("joins buttons into one options line and marks errors", () => {
    expect(
      markdown(`$done = "x"
Row([Button("Approve"), Button("Reject"), Button("Later")])
Stack([Metric("Users", "1,204", note: "+3%"), Progress($done)])`),
    ).toBe(`Options: Approve · Reject · Later

Users **1,204** (+3%)

_(error: Progress value needs a number, got text)_`);
  });

  it("marks destructive options and drops icons", () => {
    expect(
      markdown(`Button("Keep branch", icon: "check")
Button("Delete branch", variant: "destructive", icon: "trash")`),
    ).toBe("Options: Keep branch · ⚠ Delete branch");
  });

  it("renders a form as its fields, with no submit label (a legacy one is ignored)", () => {
    expect(
      markdown(`$name = "Ada"
$notify = true
Form([Input($name, label: "Name"), Toggle($notify, "Notify me")], submit: "Save")
Form([Input($name)])`),
    ).toBe("Name: Ada\n\nNotify me: on\n\nName: Ada");
  });

  it("merges tree paths and nodes into one indented list", () => {
    expect(
      markdown(`Tree([
  "src/app.ts",
  "./src/lib/",
  {label: "src", note: "sources"},
  "README.md",
  {label: "docs", children: ["intro.md", {label: "api.md", note: "draft"}]}
])`),
    ).toBe(`- src/ — sources
  - app.ts
  - lib/
- README.md
- docs/
  - intro.md
  - api.md — draft`);
  });

  it("renders few key-value pairs as lines and many as a table", () => {
    expect(markdown('KeyValue({Owner: "Ada", Status: Badge("live", tone: "good")})')).toBe(
      "**Owner:** Ada  \n**Status:** 🟢 live",
    );
    expect(markdown('KeyValue([["CPU", "4"], ["RAM", "16 GB"], ["Disk", 512], ["Zone", "eu|west"]])')).toBe(
      "|  |  |\n| --- | --- |\n| CPU | 4 |\n| RAM | 16 GB |\n| Disk | 512 |\n| Zone | eu\\|west |",
    );
  });

  it("renders quiz options with each answer after them", () => {
    expect(
      markdown(`Quiz([
  {q: "2 + 2?", options: ["3", "4"], answer: 1, why: "Arithmetic"},
  {q: "Sky?", options: ["Blue", "Green"], answer: 0},
  {q: "Open?", options: ["Yes", "No"], answer: 5}
])`),
    ).toBe(`1. 2 + 2?
   - A. 3
   - B. 4

   **Answer:** B. 4 — Arithmetic

2. Sky?
   - A. Blue
   - B. Green

   **Answer:** A. Blue

3. Open?
   - A. Yes
   - B. No`);
  });

  it("renders pie charts with each slice's share", () => {
    expect(markdown('Chart("pie", ["A", "B", "C"], [3, 1, 0], unit: "h")')).toBe(
      "|  | Value (h) | % |\n| --- | --- | --- |\n| A | 3 | 75% |\n| B | 1 | 25% |\n| C | 0 | 0% |",
    );
    expect(markdown('Chart("pie", ["Most", "Few"], {users: [999, 1]})')).toContain("| Most | 999 | 100% |\n| Few | 1 | <1% |");
  });

  it("renders snippets with their code, location only while loading, and errors", () => {
    const snippet = (props: Record<string, Value>): string =>
      toMarkdown([
        {
          kind: "node",
          type: "Snippet",
          key: "1:1",
          props: { path: "src/app.ts", from: 3, to: 5, code: null, error: null, language: null, ...props },
        },
      ]);
    expect(snippet({ code: "const a = 1;\n", language: "ts" })).toBe("`src/app.ts:3-5`\n```ts\nconst a = 1;\n```");
    expect(snippet({})).toBe("`src/app.ts:3-5`");
    expect(snippet({ from: 7, to: 7 })).toBe("`src/app.ts:7`");
    expect(snippet({ error: "File not found" })).toBe("`src/app.ts:3-5` _(error: File not found)_");
  });
});

describe("specToMarkdown", () => {
  it("compiles, evaluates and renders in one call, with loaded data", () => {
    const data = new Map([[dataKey({ path: "team.csv", raw: false }), parseDataFile("team.csv", "name,role\nAda,Lead")]]);
    const source = 'Card("Team", [Table(["Name", "Role"], Load("team.csv").map(p => [p.name, p.role]))])';
    expect(specToMarkdown(source, data)).toBe("**Team**\n\n| Name | Role |\n| --- | --- |\n| Ada | Lead |\n\nSource: `team.csv`");
    expect(specToMarkdown(source)).toBe("**Team**\n\n_(loading team.csv)_");
  });

  it("returns a broken spec as a fenced ui block", () => {
    const source = 'Card("Oops", [Nope()])';
    expect(specToMarkdown(source)).toBe("```ui\nCard(\"Oops\", [Nope()])\n```");
  });
});
