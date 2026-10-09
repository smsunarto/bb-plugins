import { defineQuery } from "@bb-kit/core/rpc";
import { inboxSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadInbox } from "../lib/inbox.ts";

/** Open pull requests waiting on the viewer, their own, and their pins. */
export const inbox = defineQuery({
  output: inboxSchema,
  async execute(ctx: CodeReviewContext) {
    return loadInbox(ctx.gh, await ctx.store.pins());
  },
});
