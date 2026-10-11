import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { localBranchesSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalBranches } from "../lib/gitbutler.ts";

/** GitButler branches with commits and no pull request, on every connected machine. */
export const localBranches = defineQuery({
  input: z.strictObject({}),
  output: localBranchesSchema,
  async execute(ctx: CodeReviewContext) {
    return loadLocalBranches(ctx.bb);
  },
});
