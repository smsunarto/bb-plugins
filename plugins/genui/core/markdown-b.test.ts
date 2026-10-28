import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";

function markdown(source: string): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return toMarkdown(evaluate(result.program, initialState(result.program)).roots);
}

describe("toMarkdown: Diagram, Walkthrough, List, Calendar", () => {
  it("follows a diagram with each node's detail under the label its source gives it", () => {
    expect(
      markdown(`Diagram("flowchart LR\\n  crank[Crankset] --> chain((Chain))\\n  chain --> hub", {
  crank: "Turns your push into rotation.",
  chain: [Callout("Keep it oiled.", "warn"), Text("It wears.")],
  hub: "",
  missing: "No such node."
})`),
    ).toBe(`\`\`\`mermaid
flowchart LR
  crank[Crankset] --> chain((Chain))
  chain --> hub
\`\`\`

**Crankset** — Turns your push into rotation.

**Chain**

> 🟠 Keep it oiled.

It wears.

**missing** — No such node.`);
  });

  it("numbers walkthrough steps, with their code fenced", () => {
    expect(
      markdown(`Walkthrough([
  {title: "Find it", body: "List commits.", code: "git log", language: "bash"},
  "Then push."
])`),
    ).toBe(`**1. Find it**

List commits.

\`\`\`bash
git log
\`\`\`

**2.**

Then push.`);
  });

  it("lists rows with their tone, detail and value, linking rows that open a URL", () => {
    expect(
      markdown(`List([
  {title: "api", detail: "p99 120 ms", tone: "good", value: "99.9%"},
  {title: "Docs", action: OpenUrl("https://example.com/docs")},
  {title: "PR 12", value: Badge("Failing", tone: "bad"), action: Send("Why?")},
  {detail: "no title"}
])`),
    ).toBe(`- 🟢 **api** — p99 120 ms · 99.9%
- [Docs](https://example.com/docs)
- **PR 12** — 🔴 Failing`);
  });

  it("groups calendar events by month in date order, skipping invalid dates", () => {
    expect(
      markdown(`Calendar([
  {date: "2026-11-03", title: "Retro"},
  {date: "2026-10-09", title: "RC 1", tone: "warn"},
  {date: "2026-02-30", title: "Never"},
  {date: "2026-10-27", title: "Release"}
])`),
    ).toBe(`**October 2026**
- Fri 9 — 🟠 RC 1
- Tue 27 — Release

**November 2026**
- Tue 3 — Retro`);
    expect(markdown(`Calendar([], "2026-10")`)).toBe("**October 2026**: no events");
  });
});
