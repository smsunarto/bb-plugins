import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { stopPrWatch } from "./stop-pr-watch.ts";

test("stopping a pull request the thread does not watch changes nothing", async () => {
  const { ctx, harness } = fakeContext();
  expect(
    await stopPrWatch(ctx, {
      threadId: "thr_a",
      ref: { owner: "acme", repo: "api", number: 7 },
    }),
  ).toEqual({ stopped: false });
  expect(harness.inspection.realtimeSignals).toEqual([]);
});
