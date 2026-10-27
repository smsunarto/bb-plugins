import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { prWatches } from "./pr-watches.ts";

test("a thread with no watches answers an empty list", async () => {
  const { ctx } = fakeContext();
  expect(await callProcedure(prWatches, ctx, { threadId: "thr_a" })).toEqual({ watches: [] });
});
