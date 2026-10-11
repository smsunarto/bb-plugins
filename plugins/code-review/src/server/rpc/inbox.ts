import { defineQuery } from "@bb-kit/core/rpc";
import { inboxSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadInboxes } from "../lib/inbox.ts";

/** Open pull requests waiting on each signed-in account, their own, and their pins. */
export const inbox = defineQuery({
  output: inboxSchema,
  async execute(ctx: CodeReviewContext) {
    return loadInboxes(ctx.github, await ctx.store.pins());
  },
});
