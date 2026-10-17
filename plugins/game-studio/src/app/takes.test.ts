import { expect, test } from "bun:test";
import type { GenerationJob } from "../shared/generation.ts";
import { batchRequestId } from "../shared/takes.ts";
import { nodeRuns } from "./takes.tsx";

const job = (id: string, status: GenerationJob["status"], createdAt: number) =>
  ({ id, status, createdAt, request: { kind: "image", outputCount: 1 } }) as GenerationJob;

test("a batch's unfinished images stay in its run beside the finished ones", () => {
  const [first, second] = [0, 1].map((index) => batchRequestId("roll", index));
  const jobs = [
    job(second!, "running", 2),
    job(first!, "succeeded", 2),
    job("solo", "succeeded", 1),
  ];
  const takes = [
    { assetId: "old", jobId: "" },
    { assetId: "a", jobId: "solo" },
    { assetId: "b", jobId: first! },
  ];
  expect(
    nodeRuns(takes, jobs).map(({ label, takes, pending, failures }) => ({
      label,
      takes: takes.map((take) => take.assetId),
      pending,
      failures: failures.length,
    })),
  ).toEqual([
    { label: "Earlier", takes: ["old"], pending: 0, failures: 0 },
    { label: "Run 1", takes: ["a"], pending: 0, failures: 0 },
    { label: "Run 2", takes: ["b"], pending: 1, failures: 0 },
  ]);
});

test("the newest run shows its failures; older failures stay quiet", () => {
  const jobs = [job("new", "failed", 3), job("old", "failed", 1)];
  expect(nodeRuns([], jobs).map(({ label, failures }) => [label, failures.length])).toEqual([
    ["Run 1", 1],
  ]);
});
