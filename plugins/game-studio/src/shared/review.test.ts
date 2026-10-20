import { expect, test } from "bun:test";
import {
  outputReview,
  retryLineage,
  retryRequestId,
  retryWanted,
  reviewedJobId,
  reviewRequestId,
  reviewVerdict,
} from "./review.ts";

test("the verdict comes from the review's first line only", () => {
  expect(reviewVerdict("**Pass** — clean silhouette.")).toBe("pass");
  expect(reviewVerdict("\n**Pass with fixes** — eyes need repair.")).toBe("fixes");
  expect(reviewVerdict("**Fail** — two subjects.")).toBe("fail");
  expect(reviewVerdict("Looks fine.\n**Fail** later")).toBeUndefined();
});

test("an output shows its newest review", () => {
  const node: Parameters<typeof outputReview>[0] = {
    data: {
      reviews: [
        { assetIds: ["a", "b"], jobId: "1", text: "**Fail**" },
        { assetIds: ["a"], jobId: "2", text: "**Pass**" },
        { malformed: true },
      ],
    },
  };
  expect(outputReview(node, "a")?.jobId).toBe("2");
  expect(outputReview(node, "b")?.jobId).toBe("1");
  expect(outputReview(node, "c")).toBeUndefined();
});

test("a run's review id stays a valid generation id", () => {
  expect(reviewRequestId("x".repeat(100))).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
});

test("retries count from the run that began the chain", () => {
  expect(retryLineage("run")).toEqual({ root: "run", attempt: 0 });
  expect(retryRequestId("run")).toBe("run-retry-1");
  expect(retryRequestId("run-retry-1")).toBe("run-retry-2");
  expect(retryLineage("run-retry-2")).toEqual({ root: "run", attempt: 2 });
  expect(retryRequestId("x".repeat(100))).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
  expect(reviewedJobId(reviewRequestId("run-retry-1"))).toBe("run-retry-1");
  expect(reviewedJobId("manual-uuid")).toBeUndefined();
});

test("a retry follows only the verdicts and count the node allows", () => {
  const settings = { enabled: true, retries: 2 };
  expect(retryWanted(settings, "fail", 0)).toBe(true);
  expect(retryWanted(settings, "fail", 2)).toBe(false);
  expect(retryWanted(settings, "fixes", 0)).toBe(false);
  expect(retryWanted({ ...settings, retryOn: "fixes" }, "fixes", 1)).toBe(true);
  expect(retryWanted(settings, "pass", 0)).toBe(false);
  expect(retryWanted(settings, undefined, 0)).toBe(false);
  expect(retryWanted({ ...settings, enabled: false }, "fail", 0)).toBe(false);
  expect(retryWanted({ enabled: true }, "fail", 0)).toBe(false);
});
