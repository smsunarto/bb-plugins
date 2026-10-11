import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema, checksSchema, prRefSchema } from "../../shared/schema.ts";
import { loadChecks } from "../lib/checks.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Check runs and commit statuses on the head commit: failures first, then running ones. */
export const checks = defineQuery({
  input: z.strictObject({ account: accountSchema, ref: prRefSchema }),
  output: checksSchema,
  async execute(ctx: CodeReviewContext, { account, ref }) {
    return loadChecks(ctx.github.as(account), ref);
  },
});
