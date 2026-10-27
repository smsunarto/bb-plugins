import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema, prRefSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadPrActionState, prActionStateSchema } from "../lib/pr-actions.ts";

export const prActionState = defineQuery({
  input: z.strictObject({ account: accountSchema, ref: prRefSchema }),
  output: prActionStateSchema,
  execute: (ctx: CodeReviewContext, { account, ref }) =>
    loadPrActionState(ctx.github.as(account), ref),
});
