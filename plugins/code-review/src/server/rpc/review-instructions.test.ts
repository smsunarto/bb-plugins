import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { reviewInstructions } from "./review-instructions.ts";
import { setReviewInstructions } from "./set-review-instructions.ts";

test("reads empty until instructions are saved, then reads them back", async () => {
  const { ctx } = fakeContext();
  expect(await reviewInstructions.execute(ctx)).toEqual({ instructions: "" });
  await setReviewInstructions.execute(ctx, { instructions: "Check the migrations." });
  expect(await reviewInstructions.execute(ctx)).toEqual({ instructions: "Check the migrations." });
});
