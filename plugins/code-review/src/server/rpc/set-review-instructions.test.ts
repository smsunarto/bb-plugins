import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { setReviewInstructions, setReviewInstructionsContract } from "./set-review-instructions.ts";

test("saves trimmed instructions and refuses more than 8000 characters", async () => {
  const { ctx } = fakeContext();
  expect(await setReviewInstructions(ctx, { instructions: "  Prefer small diffs.  " })).toEqual({
    instructions: "Prefer small diffs.",
  });
  expect(
    setReviewInstructionsContract.input.safeParse({ instructions: "x".repeat(8001) }).error
      ?.issues[0]?.message,
  ).toBe("Keep review instructions under 8000 characters.");
  expect(await ctx.store.instructions()).toBe("Prefer small diffs.");
});
