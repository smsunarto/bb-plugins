import { expect, test } from "vitest";
import { parseReviewAgentTraceListResponse } from "../../../shared/vendor/review-protocol/src/index.ts";
import { listPinnedTraces } from "./traces.ts";

const pins = { repositoryId: "repo", base: "base", head: "head" };

test("the unconfigured trace list parses as an empty loaded list", async () => {
  expect(parseReviewAgentTraceListResponse(await listPinnedTraces("/repo", pins))).toEqual({
    ok: true,
    configured: false,
    storage: "none",
    sources: [],
    sessions: [],
  });
});

test("a storage override is reported back", async () => {
  expect((await listPinnedTraces("/repo", pins, "s3")).storage).toBe("s3");
});
