import { z } from "zod";
import { statusSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { GhError } from "../lib/gh.ts";

/**
 * Whether `gh` on the bb server is installed and signed in, to which
 * accounts, and which one is active. Never throws.
 */
export const statusContract = {
  input: z.null(),
  output: statusSchema,
};

export async function status(
  ctx: CodeReviewContext,
): Promise<z.input<typeof statusContract.output>> {
  try {
    const accounts = await ctx.github.accounts();
    return { ok: true, login: accounts[0] ?? "", accounts };
  } catch (error) {
    const code = error instanceof GhError ? error.code : "failed";
    const reason = code === "gh-missing" || code === "unauthenticated" ? code : "failed";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason, message };
  }
}
