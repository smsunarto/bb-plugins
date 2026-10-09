import { defineQuery } from "@bb-kit/core/rpc";
import { type Status, statusSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { GhError } from "../lib/gh.ts";

/** Whether `gh` on the bb server is installed and signed in, and as whom. Never throws. */
export const status = defineQuery({
  output: statusSchema,
  async execute(ctx: CodeReviewContext): Promise<Status> {
    try {
      const user = (await ctx.gh.rest("user")) as { login: string };
      return { ok: true, login: user.login };
    } catch (error) {
      const code = error instanceof GhError ? error.code : "failed";
      const reason = code === "gh-missing" || code === "unauthenticated" ? code : "failed";
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason, message };
    }
  },
});
