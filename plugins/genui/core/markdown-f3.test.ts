import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";

function markdown(source: string): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return toMarkdown(evaluate(result.program, initialState(result.program)).roots);
}

describe("toMarkdown: decisions", () => {
  it("renders a Plan as a numbered list with risks, estimates, details, files, the total and the Approve choice, ignoring a legacy submit label", () => {
    expect(
      markdown(`Plan([
  {title: "Add a limiter", detail: "Token bucket per host", files: ["web/limiter.ts", "web/photon.ts:40"], risk: "low", estimate: "2h"},
  {title: "Migrate the old rows", risk: "high", estimate: "1d", optional: true},
  {title: "Document it", estimate: "30m"}
], submit: "Start")`),
    ).toBe(`**Plan** · 3 steps · 2.5 h without optional steps

1. Add a limiter · low risk · 2 h
   Token bucket per host
   \`web/limiter.ts\` \`web/photon.ts:40\`
2. _(optional)_ Migrate the old rows · **high risk** · 1 d
3. Document it · 30 min

Options: Approve`);
  });

  it("says when there are no steps", () => {
    expect(markdown(`Plan([])`)).toBe("**Plan** · no steps");
    expect(markdown(`Plan(["Ship"])`)).toBe("**Plan** · 1 step\n\n1. Ship\n\nOptions: Approve");
  });

  it("renders a Decision as its verdict, the weighted matrix, pros and cons and the options", () => {
    expect(
      markdown(`Decision([
  {name: "BullMQ", scores: [4, 4, 5], pros: ["Runs on our Redis"], cons: ["Redis memory"]},
  {name: "Kafka", scores: {Throughput: 5, "Ops cost": 1, Ecosystem: 5}},
  {name: "SQS | FIFO", scores: [3, 5, 3], note: "AWS only"}
], ["Throughput", {name: "Ops cost", weight: 2}, "Ecosystem"])`),
    ).toBe(`**Decision** · BullMQ leads with 4.25 of 5, 0.25 ahead of SQS | FIFO

| Criterion | Weight | BullMQ | Kafka | SQS \\| FIFO |
| --- | --- | --- | --- | --- |
| Throughput | 1 | 4 | 5 | 3 |
| Ops cost | 2 | 4 | 1 | 5 |
| Ecosystem | 1 | 5 | 5 | 3 |
| **Weighted score** |  | **4.25** | 3 | 4 |

- **BullMQ**: + Runs on our Redis; − Redis memory
- **SQS | FIFO**: AWS only

Options: Go with BullMQ · Go with SQS | FIFO · Go with Kafka`);
  });

  it("calls a tie and lists input problems", () => {
    expect(markdown(`Decision([{name: "A", scores: [3]}, {name: "B", scores: [3, 9]}], ["x", "y"])`)).toBe(`**Decision** · B leads with 6 of 10, 4.5 ahead of A

| Criterion | Weight | A | B |
| --- | --- | --- | --- |
| x | 1 | 3 | 3 |
| y | 1 | — | 9 |
| **Weighted score** |  | 1.5 | **6** |

_One score is missing and counts as 0._

Options: Go with B · Go with A`);
    expect(markdown(`Decision([{name: "A", scores: [3]}, {name: "B", scores: [3]}], ["x"])`)).toContain("**Decision** · A and B are tied at 3 of 5");
    expect(markdown(`Decision([], [])`)).toBe("_(Decision needs at least one criterion)_");
  });

  it("renders an Estimate as PERT totals and a task table, invalid rows explained", () => {
    expect(
      markdown(`Estimate([
  {title: "API", low: 2, likely: 3, high: 6},
  {title: "UI", low: 1, likely: 2, high: 9},
  {title: "Rollout", low: 4, likely: 5, high: 12},
  {title: "Docs", low: 3, high: 1}
], "d")`),
    ).toBe(`**Estimate** · 4 tasks · expected **12.3 d** · P50 12.3 d · P80 14 d · P90 14.9 d · range 7–27 d

| Task | Low (d) | Likely | High | PERT mean |
| --- | --- | --- | --- | --- |
| API | 2 | 3 | 6 | 3.3 |
| UI | 1 | 2 | 9 | 3 |
| Rollout | 4 | 5 | 12 | 6 |
| Docs | 3 | — | 1 | ⚠ not counted: low 3 is above high 1 |`);
  });

  it("shows the midpoint used for a missing likely, units, and an empty list", () => {
    expect(markdown(`Estimate([{title: "Spike", low: 3, high: 8}], "pts")`)).toBe(`**Estimate** · 1 task · expected **5.5 pts** · P50 5.5 pts · P80 6.2 pts · P90 6.6 pts · range 3–8 pts

| Task | Low (pts) | Likely | High | PERT mean |
| --- | --- | --- | --- | --- |
| Spike | 3 | (5.5) | 8 | 5.5 |`);
    expect(markdown(`Estimate([])`)).toBe("**Estimate** · no tasks");
  });
});
