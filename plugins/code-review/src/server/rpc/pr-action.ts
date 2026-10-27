import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { prActionIssue } from "../../shared/pr-actions.ts";
import { accountSchema, prRefSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadPrActionState } from "../lib/pr-actions.ts";

export const prAction = defineMutation({
  input: z.strictObject({
    account: accountSchema,
    ref: prRefSchema,
    action: z.enum(["close", "reopen", "draft", "ready", "merge"]),
    headRefOid: z.string().min(1),
    method: z.enum(["merge", "squash", "rebase"]),
  }),
  output: z.strictObject({ message: z.string() }),
  async execute(ctx: CodeReviewContext, { account, ref, action, headRefOid, method }) {
    const gh = ctx.github.as(account);
    const pr = await loadPrActionState(gh, ref);
    const issue = prActionIssue({ policy: pr, action, headRefOid, method });
    if (issue) throw new Error(issue);
    if (action === "merge") {
      const result = z.object({ merged: z.boolean(), message: z.string() }).parse(
        await gh.rest(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/merge`, {
          method: "PUT",
          body: { sha: headRefOid, merge_method: method },
        }),
      );
      if (!result.merged) throw new Error(result.message);
      return { message: "Pull request merged." };
    }
    const command = action === "draft" ? "ready" : action;
    await gh.text([
      "pr",
      command,
      String(ref.number),
      "--repo",
      `${ref.owner}/${ref.repo}`,
      ...(action === "draft" ? ["--undo"] : []),
    ]);
    const messages = {
      ready: "Pull request ready for review.",
      draft: "Pull request marked as draft.",
      close: "Pull request closed.",
      reopen: "Pull request reopened.",
    };
    return { message: messages[action] };
  },
});
