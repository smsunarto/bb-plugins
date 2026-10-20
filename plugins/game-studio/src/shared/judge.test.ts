import { expect, test } from "bun:test";
import { judgeChoice, judgeRequestId, manualCandidates, runCandidates } from "./judge.ts";

test("the choice comes from the judgement's first line only", () => {
  const candidates = ["a", "b", "c"];
  expect(judgeChoice("**Pick: Candidate 2** — cleanest rim.", candidates)).toBe("b");
  expect(judgeChoice("\n**pick : candidate 3**", candidates)).toBe("c");
  expect(judgeChoice("**Pick: Candidate 4**", candidates)).toBeUndefined();
  expect(judgeChoice("Close call.\n**Pick: Candidate 1**", candidates)).toBeUndefined();
});

test("a run competes as a whole batch against the current pick", () => {
  const node = {
    data: {
      assetId: "old",
      takes: [
        { assetId: "old", jobId: "earlier" },
        { assetId: "b0", jobId: "run-b0" },
        { assetId: "b1", jobId: "run-b1" },
        { assetId: "other", jobId: "later" },
      ],
    },
  };
  expect(runCandidates(node, "run")).toEqual(["old", "b0", "b1"]);
  // A run of one still has to beat the pick, and a pick from the run is not counted twice.
  expect(runCandidates({ data: { ...node.data, assetId: "b0" } }, "run")).toEqual(["b0", "b1"]);
  expect(runCandidates({ data: { takes: [{ assetId: "x", jobId: "solo" }] } }, "solo")).toEqual([
    "x",
  ]);
});

test("Judge now compares the shortlist when it holds two or more", () => {
  const takes: Record<string, string | boolean>[] = [
    { assetId: "a", jobId: "1", star: true },
    { assetId: "b", jobId: "1" },
    { assetId: "c", jobId: "2", star: true },
  ];
  expect(manualCandidates({ data: { takes } })).toEqual(["a", "c"]);
  expect(manualCandidates({ data: { takes: takes.slice(0, 2) } })).toEqual(["a", "b"]);
});

test("a run's judge id stays a valid generation id", () => {
  expect(judgeRequestId("x".repeat(100))).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
});
