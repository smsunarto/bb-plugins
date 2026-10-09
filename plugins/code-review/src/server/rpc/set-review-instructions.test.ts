import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { setReviewInstructions } from "./set-review-instructions.ts";

test("saves trimmed instructions and refuses more than 8000 characters", async () => {
  const { ctx } = fakeContext();
  expect(
    await callProcedure(setReviewInstructions, ctx, { instructions: "  Prefer small diffs.  " }),
  ).toEqual({ instructions: "Prefer small diffs." });
  await expect(
    callProcedure(setReviewInstructions, ctx, { instructions: "x".repeat(8001) }),
  ).rejects.toThrow("Keep review instructions under 8000 characters.");
  expect(await ctx.store.instructions()).toBe("Prefer small diffs.");
});
