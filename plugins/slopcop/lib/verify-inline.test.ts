import { Effect } from "effect";
import { expect, it } from "vitest";
import { createGhClient, type GhComment } from "./gh";
import { buildMarker } from "./marker";
import { verifyLive } from "./verify";

const comment = (overrides: Partial<GhComment>): GhComment => ({
  id: "inline",
  body: "keep this lock until the write completes",
  author: "review-bot",
  path: "src/worker.go",
  line: 42,
  url: null,
  createdAt: 2000,
  ...overrides,
});

it.each(["our-review", "another-review"])(
  "attributes plain inline notes only to their marked parent (%s)",
  async (reviewId) => {
    const gh = {
      ...createGhClient("unused"),
      listIssueComments: () => Effect.succeed([]),
      listReviews: () =>
        Effect.succeed([
          comment({
            id: "our-review",
            path: null,
            line: null,
            body: buildMarker({ rule: "rule", run: "our-run", sha: "head", kind: "summary" }),
          }),
        ]),
      listReviewComments: () => Effect.succeed([comment({ reviewId })]),
    };
    const result = await Effect.runPromise(
      verifyLive({
        gh,
        repo: "owner/repo",
        prNumber: 1,
        runId: "our-run",
        startedAt: 1000,
        authenticatedLogin: "review-bot",
      }),
    );
    expect(result.status).toBe(reviewId === "our-review" ? "commented" : "commented_partial");
    expect(result.comments).toHaveLength(2);
  },
);
