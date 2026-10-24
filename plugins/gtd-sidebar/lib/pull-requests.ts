import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The bundled plugin that owns pull request data, keyed by environment. */
export const GITHUB_PR_STATUS_PLUGIN_ID = "bb--github-pr-status";

const rowPullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  attention: z.string(),
});

/** A row's pull request: the fields the card draws. */
export type RowPullRequest = z.infer<typeof rowPullRequestSchema>;

/**
 * The part of GitHub PR Status's `pullRequests` read this sidebar draws. Each
 * key is an environment id; `absent` and `unavailable` (machine offline, `gh`
 * failed) both mean nothing to show.
 */
export const githubPrStatusContract = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({ outcome: z.literal("available"), pullRequest: rowPullRequestSchema }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
});
