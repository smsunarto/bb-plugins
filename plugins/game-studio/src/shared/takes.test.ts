import { expect, test } from "bun:test";
import { batchRequestId, keptRuns, nodeTakes, pruneTakes, takeRun, type Take } from "./takes.ts";

test("a batch's takes share one run, and single runs keep their own", () => {
  const id = "0b7c6f1e-4d2a-4c1b-9e3f-1a2b3c4d5e60";
  expect([0, 1, 3].map((index) => takeRun(batchRequestId(id, index)))).toEqual([id, id, id]);
  expect(takeRun(id)).toBe(id);
  expect(takeRun("")).toBe("");
});

test("a pick from before takes existed becomes the first take", () => {
  expect(
    nodeTakes({ data: { assetId: "old", takes: [{ assetId: "new", jobId: "job" }] } }),
  ).toEqual([
    { assetId: "old", jobId: "" },
    { assetId: "new", jobId: "job" },
  ]);
});

test("takes of runs older than the newest five go unless starred or picked", () => {
  const legacy = { assetId: "legacy", jobId: "" };
  const runs = Array.from({ length: keptRuns + 2 }, (_, run): Take[] => [
    { assetId: `r${run}a`, jobId: batchRequestId(`run-${run}`, 0) },
    { assetId: `r${run}b`, jobId: batchRequestId(`run-${run}`, 1) },
  ]);
  runs[0]![1] = { ...runs[0]![1]!, star: true };
  const takes = [legacy, ...runs.flat()];
  expect(pruneTakes(takes, "r1a").map(({ assetId }) => assetId)).toEqual([
    "r0b",
    "r1a",
    ...runs.slice(2).flatMap((run) => run.map(({ assetId }) => assetId)),
  ]);
  // A node with no more than five runs keeps everything, including takes from before runs.
  expect(pruneTakes(takes.slice(0, 1 + 2 * (keptRuns - 1)), undefined)).toHaveLength(
    1 + 2 * (keptRuns - 1),
  );
});
