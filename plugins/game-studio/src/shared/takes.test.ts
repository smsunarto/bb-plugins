import { expect, test } from "bun:test";
import { batchRequestId, nodeTakes, takeRun } from "./takes.ts";

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
