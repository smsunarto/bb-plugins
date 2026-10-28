import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { prWatches } from "./pr-watches.ts";

test("a thread with no watches answers an empty list", async () => {
  const { ctx } = fakeContext();
  expect(await prWatches(ctx, { threadId: "thr_a" })).toEqual({ watches: [] });
});
