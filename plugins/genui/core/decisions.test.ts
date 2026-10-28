import { describe, expect, it } from "vitest";
import type { Value } from "./types";
import {
  acceptEdits,
  applyEdits,
  decisionMessage,
  estimateTask,
  estimateTotals,
  estimateUnit,
  formatQuantity,
  formatWithUnit,
  initialChecks,
  leaderMargin,
  nudgeWeight,
  numberList,
  parseQuantity,
  planMessage,
  planTotal,
  rankOptions,
  readDecision,
  readEstimate,
  readPlan,
  weightMax,
  weightStep,
  Z80,
  Z90,
  type DecisionModel,
} from "./decisions";

const STEPS = readPlan([
  { title: "Add the limiter", files: ["web/limiter.ts", "server.ts:42"], risk: "low", estimate: "2h" },
  { title: "Wire it into Photon", estimate: "30 min" },
  { title: "Migrate the old rows", risk: "high", estimate: "1d", optional: true },
  { title: "Document it", estimate: "1 h" },
]).steps;

describe("readPlan", () => {
  it("reads steps, files with lines, risks and estimates; bare strings are titles; untitled items (streaming) are skipped", () => {
    const { steps, error } = readPlan([
      { title: "A", files: "core/data.ts:12:3", risk: "Med", estimate: "~1.5 d", detail: "why" },
      "B",
      { detail: "still streaming" },
      { title: "C", files: [{ path: "ui/render.tsx", line: 7 }, "", "README.md"], risk: "extreme", estimate: "half a day" },
    ]);
    expect(error).toBeNull();
    expect(steps.map((step) => step.title)).toEqual(["A", "B", "C"]);
    expect(steps[0]).toMatchObject({ files: [{ path: "core/data.ts", line: 12 }], risk: "medium", amount: { value: 1.5, unit: "d" }, detail: "why" });
    expect(steps[1]).toMatchObject({ files: [], risk: null, estimate: null, amount: null, optional: false });
    expect(steps[2]).toMatchObject({
      files: [
        { path: "ui/render.tsx", line: 7 },
        { path: "README.md", line: null },
      ],
      risk: null,
      estimate: "half a day",
      amount: null,
    });
  });

  it("reports a non-list", () => {
    expect(readPlan("steps").error).toBe("Plan needs a list of steps");
    expect(readPlan([]).steps).toEqual([]);
  });

  it("keeps Windows paths with a drive letter whole", () => {
    expect(readPlan([{ title: "x", files: ["C:\\repo\\src\\a.ts:9"] }]).steps[0].files).toEqual([{ path: "C:\\repo\\src\\a.ts", line: 9 }]);
  });

  it("starts optional steps unchecked", () => {
    expect(initialChecks(STEPS)).toEqual([true, true, false, true]);
  });
});

describe("planMessage", () => {
  const all = [true, true, true, true];

  it("approves the whole plan in one sentence", () => {
    expect(planMessage(STEPS, all)).toBe("Go ahead with the plan.");
  });

  it("names the steps to do and the skipped ones with their titles", () => {
    expect(planMessage(STEPS, [true, true, false, true])).toBe("Go ahead with steps 1, 2 and 4. Skip 3 (Migrate the old rows).");
    expect(planMessage(STEPS, [true, false, false, true])).toBe(
      "Go ahead with steps 1 and 4. Skip 2 (Wire it into Photon) and 3 (Migrate the old rows).",
    );
    expect(planMessage(STEPS, [false, false, true, false])).toBe(
      "Go ahead with step 3. Skip 1 (Add the limiter), 2 (Wire it into Photon) and 4 (Document it).",
    );
  });

  it("approves nothing when nothing is checked", () => {
    expect(planMessage(STEPS, [false, false, false, false])).toBe("");
  });

  it("reads runs of three or more steps as ranges", () => {
    expect(numberList([1, 2, 4])).toBe("1, 2 and 4");
    expect(numberList([1, 2, 3, 4, 6, 8, 9, 10])).toBe("1–4, 6 and 8–10");
    expect(numberList([5])).toBe("5");
    expect(numberList([])).toBe("");
  });

  it("treats missing checks (a step streamed in after the state was saved) as checked", () => {
    expect(planMessage(STEPS, [true, true])).toBe("Go ahead with the plan.");
  });
});

describe("planTotal", () => {
  it("adds time units in the largest unit present (8 h days, 5 day weeks)", () => {
    expect(planTotal(STEPS, initialChecks(STEPS))).toEqual({ total: { value: 3.5, unit: "h" }, unparsed: 0, mixed: false });
    expect(planTotal(STEPS, [true, true, true, true])).toEqual({ total: { value: 1.44, unit: "d" }, unparsed: 0, mixed: false });
    expect(formatQuantity({ value: 1.44, unit: "d" })).toBe("1.4 d");
  });

  it("counts unparsed estimates and refuses to add points to hours", () => {
    const steps = readPlan([
      { title: "a", estimate: "3 pts" },
      { title: "b", estimate: "2h" },
      { title: "c", estimate: "a while" },
      { title: "d" },
    ]).steps;
    expect(planTotal(steps, [true, true, true, true])).toEqual({ total: null, unparsed: 1, mixed: true });
    expect(planTotal(steps, [true, false, true, true])).toEqual({ total: { value: 3, unit: "pts" }, unparsed: 1, mixed: false });
    expect(planTotal(steps, [false, false, false, false])).toEqual({ total: null, unparsed: 0, mixed: false });
  });

  it("parses the estimate spellings agents write", () => {
    expect(parseQuantity("45m")).toEqual({ value: 45, unit: "m" });
    expect(parseQuantity("2 hrs")).toEqual({ value: 2, unit: "h" });
    expect(parseQuantity("1 week")).toEqual({ value: 1, unit: "w" });
    expect(parseQuantity("5 SP")).toEqual({ value: 5, unit: "pts" });
    expect(parseQuantity(4)).toEqual({ value: 4, unit: "" });
    expect(parseQuantity("2-3h")).toBeNull();
    expect(parseQuantity("3 apples")).toBeNull();
    expect(parseQuantity(-1)).toBeNull();
    expect(formatQuantity({ value: 1, unit: "pts" })).toBe("1 pt");
  });
});

describe("readDecision and rankOptions", () => {
  const criteria: Value = ["Throughput", { name: "Ops cost", weight: 2, note: "we are two people" }, { name: "Ecosystem", weight: 1 }];
  const read = readDecision(
    [
      { name: "BullMQ", scores: [4, 4, 5], pros: ["Redis we already run"], cons: "Redis memory" },
      { name: "Kafka", scores: { throughput: 5, "Ops cost": 1, Ecosystem: 5 } },
      { name: "SQS", scores: [3, 5, 3] },
    ],
    criteria,
  );
  if (!read.ok) throw new Error(read.error);
  const model: DecisionModel = read.model;

  it("reads criteria with weights and scores as lists or by criterion name, case-insensitively", () => {
    expect(read.ok).toBe(true);
    expect(model.criteria).toEqual([
      { name: "Throughput", weight: 1, note: null },
      { name: "Ops cost", weight: 2, note: "we are two people" },
      { name: "Ecosystem", weight: 1, note: null },
    ]);
    expect(model.options.map((option) => option.scores)).toEqual([
      [4, 4, 5],
      [5, 1, 5],
      [3, 5, 3],
    ]);
    expect(model.options[0]).toMatchObject({ pros: ["Redis we already run"], cons: ["Redis memory"] });
    expect(model.scale).toBe(5);
    expect(model.issues).toEqual([]);
  });

  it("ranks by the weighted mean score and gives the leader's margin", () => {
    const ranked = rankOptions(model, [1, 2, 1]);
    expect(ranked.map((entry) => [model.options[entry.index].name, entry.total])).toEqual([
      ["BullMQ", 4.25],
      ["SQS", 4],
      ["Kafka", 3],
    ]);
    expect(leaderMargin(ranked)).toEqual({ margin: 0.25, tied: [] });
  });

  it("sends the choice, with the user's weights when they changed any", () => {
    expect(decisionMessage(model, 0, [1, 2, 1])).toBe("Go with BullMQ.");
    expect(decisionMessage(model, 1, [3, 0, 1.25])).toBe("Go with Kafka. My weights: Throughput 3, Ops cost 0, Ecosystem 1.25.");
  });

  it("re-ranks when the user changes a weight", () => {
    const ranked = rankOptions(model, [3, 0, 1]);
    expect(model.options[ranked[0].index].name).toBe("Kafka");
    expect(ranked[0].total).toBe(5);
  });

  it("calls equal totals a tie, and all-zero weights a tie at 0", () => {
    const ranked = rankOptions(model, [0, 0, 0]);
    expect(ranked.map((entry) => entry.total)).toEqual([0, 0, 0]);
    expect(leaderMargin(ranked)).toEqual({ margin: 0, tied: [1, 2] });
    expect(leaderMargin([])).toBeNull();
  });

  it("counts missing scores as 0 and explains bad input", () => {
    const result = readDecision(
      [
        { name: "A", scores: [4] },
        { name: "B", scores: { Speed: "x", Colour: 3 } },
        { name: "C", scores: [1, 2, 3] },
      ],
      [{ name: "Speed", weight: -1 }, "Cost"],
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.model.options.map((option) => option.scores)).toEqual([
      [4, null],
      [null, null],
      [1, 2],
    ]);
    expect(result.model.issues).toEqual([
      "Weight -1 for Speed isn't a number of 0 or more; using 1.",
      "B: score x for Speed isn't a number of 0 or more.",
      "B scores “Colour”, which isn't a criterion.",
      "C has 3 scores for 2 criteria; the extra ones are ignored.",
      "3 scores are missing and count as 0.",
    ]);
  });

  it("detects 1–10 and percentage scales", () => {
    const ten = readDecision([{ name: "A", scores: [7, 9] }], ["x", "y"]);
    expect(ten.ok && ten.model.scale).toBe(10);
    const hundred = readDecision([{ name: "A", scores: [70, 140] }], ["x", "y"]);
    expect(hundred.ok && hundred.model.scale).toBe(100);
    expect(hundred.ok && hundred.model.options[0].scores).toEqual([70, 100]);
  });

  it("fails without criteria or lists", () => {
    expect(readDecision([], [])).toEqual({ ok: false, error: "Decision needs at least one criterion" });
    expect(readDecision(null, ["a"])).toEqual({ ok: false, error: "Decision needs a list of options" });
    expect(readDecision([], "a")).toEqual({ ok: false, error: "Decision needs a list of criteria" });
  });

  it("steps weights on a grid that fits how they were written", () => {
    expect(weightStep([1, 2, 1])).toBe(1);
    expect(weightMax([1, 2, 1])).toBe(10);
    expect(weightStep([30, 50, 20])).toBe(5);
    expect(weightMax([30, 50, 20])).toBe(100);
    expect(weightStep([0.5, 0.3, 0.2])).toBe(0.05);
    expect(weightMax([0.5, 0.3, 0.2])).toBe(1);
    expect(nudgeWeight(0.3, 1, 0.05, 1)).toBe(0.35);
    expect(nudgeWeight(0, -1, 1, 10)).toBe(0);
    expect(nudgeWeight(10, 1, 1, 10)).toBe(10);
  });
});

describe("Estimate (PERT)", () => {
  it("reads tasks, numbers as text and the usual field aliases", () => {
    expect(
      readEstimate([
        { title: "API", low: 2, likely: "3", high: 6 },
        { name: "UI", optimistic: 1, pessimistic: 4 },
        "Docs",
      ]).tasks,
    ).toEqual([
      { title: "API", low: 2, likely: 3, high: 6 },
      { title: "UI", low: 1, likely: null, high: 4 },
      { title: "Docs", low: null, likely: null, high: null },
    ]);
    expect(readEstimate({}).error).toBe("Estimate needs a list of tasks");
  });

  it("computes the PERT mean and σ per task; likely defaults to the midpoint", () => {
    expect(estimateTask({ title: "a", low: 2, likely: 3, high: 6 })).toMatchObject({ error: null, likely: 3, mean: 20 / 6, sd: 4 / 6 });
    expect(estimateTask({ title: "b", low: 1, likely: null, high: 4 })).toMatchObject({ likely: 2.5, mean: 2.5, sd: 0.5 });
    expect(estimateTask({ title: "c", low: 5, likely: 5, high: 5 })).toMatchObject({ mean: 5, sd: 0 });
  });

  it("explains invalid rows", () => {
    expect(estimateTask({ title: "a", low: 5, likely: null, high: 3 }).error).toBe("low 5 is above high 3");
    expect(estimateTask({ title: "a", low: 1, likely: 9, high: 3 }).error).toBe("likely 9 is outside 1–3");
    expect(estimateTask({ title: "a", low: null, likely: null, high: 3 }).error).toBe("needs low");
    expect(estimateTask({ title: "a", low: null, likely: null, high: null }).error).toBe("needs low and high");
    expect(estimateTask({ title: "a", low: -1, likely: null, high: 3 }).error).toBe("estimates can't be negative");
  });

  it("adds means and variances, P50/P80/P90 from the normal approximation, invalid rows left out", () => {
    const totals = estimateTotals(
      [
        { title: "a", low: 2, likely: 3, high: 6 },
        { title: "b", low: 1, likely: 2, high: 9 },
        { title: "c", low: 4, likely: 5, high: 12 },
        { title: "bad", low: 9, likely: null, high: 1 },
      ].map(estimateTask),
    );
    const sd = Math.sqrt((4 / 6) ** 2 + (8 / 6) ** 2 + (8 / 6) ** 2);
    const mean = 20 / 6 + 18 / 6 + 36 / 6;
    expect(totals.count).toBe(3);
    expect(totals.excluded).toBe(1);
    expect(totals.low).toBe(7);
    expect(totals.high).toBe(27);
    expect(totals.mean).toBeCloseTo(mean, 10);
    expect(totals.sd).toBeCloseTo(sd, 10);
    expect(totals.p50).toBeCloseTo(mean, 10);
    expect(totals.p80).toBeCloseTo(mean + Z80 * sd, 10);
    expect(totals.p90).toBeCloseTo(mean + Z90 * sd, 10);
    // By hand: mean 74/6 ≈ 12.33, σ = √(4/9 + 16/9 + 16/9) = 2, P90 ≈ 12.33 + 1.28 × 2.
    expect(totals.sd).toBeCloseTo(2, 10);
    expect(totals.p90).toBeCloseTo(14.9, 2);
  });

  it("clamps the percentiles to the sum of the highs", () => {
    const totals = estimateTotals([estimateTask({ title: "a", low: 0, likely: 10, high: 10 })]);
    expect(totals.mean).toBeCloseTo(50 / 6, 10);
    expect(totals.p90).toBe(10);
  });

  it("is all zeros with no valid task", () => {
    expect(estimateTotals([])).toEqual({ count: 0, excluded: 0, low: 0, high: 0, mean: 0, sd: 0, p50: 0, p80: 0, p90: 0 });
  });

  it("applies the user's inline edits and accepts only well-formed stored edits", () => {
    const tasks = readEstimate([
      { title: "a", low: 1, likely: 2, high: 3 },
      { title: "b", low: 1, high: 3 },
    ]).tasks;
    expect(applyEdits(tasks, { "0": { likely: null, high: 5 }, "1": { low: 2 } })).toEqual([
      { title: "a", low: 1, likely: null, high: 5 },
      { title: "b", low: 2, likely: null, high: 3 },
    ]);
    expect(acceptEdits({ "0": { low: 2 } })).toEqual({ "0": { low: 2 } });
    expect(acceptEdits({ "0": { low: "x" } })).toBeNull();
    expect(acceptEdits({ "0": { mean: 2 } })).toBeNull();
    expect(acceptEdits([1])).toBeNull();
  });

  it("names units", () => {
    expect(estimateUnit(undefined)).toBe("d");
    expect(estimateUnit("hours")).toBe("h");
    expect(estimateUnit("points")).toBe("pts");
    expect(estimateUnit("sprints")).toBe("sprints");
    expect(formatWithUnit(1, "pts")).toBe("1 pt");
    expect(formatWithUnit(12.345, "d")).toBe("12.3 d");
  });
});
