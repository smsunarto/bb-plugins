import { expect, test } from "bun:test";
import { outputReview, reviewRequestId, reviewVerdict } from "./review.ts";

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
