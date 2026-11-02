/**
 * The RPCs of each thread's GitButler pull request, which the app reads
 * through `experimental_useRpcKeyedQuery` and the server serves.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  pullRequestActionSchema,
  threadPullRequestSchema,
  threadPullRequestTag,
  THREAD_PULL_REQUESTS_MAX_KEYS,
} from "./pull-request.ts";

export const threadPullRequestsContract = {
  experimental_description:
    "The GitHub pull request of each thread's own GitButler branch, keyed by thread id. Absent outside GitButler workspaces.",
  input: z
    .object({ keys: z.array(z.string().min(1)).min(1).max(THREAD_PULL_REQUESTS_MAX_KEYS) })
    .strict(),
  output: z.record(z.string(), threadPullRequestSchema),
  keyTags: (key: string) => [threadPullRequestTag(key)],
};

const threadInput = z.object({ threadId: z.string().min(1) }).strict();

export const refreshThreadPullRequestContract = {
  experimental_description:
    "Re-check the thread's pull request on GitHub now and resolve once its row is current.",
  input: threadInput,
  output: z.object({ ok: z.literal(true) }).strict(),
};

export const threadPullRequestActionContract = {
  experimental_description:
    "Mark the thread's draft pull request ready, convert it to a draft, or merge it.",
  input: threadInput
    .extend({
      action: pullRequestActionSchema,
      /** The pull request the reader saw, which the action must still find. */
      url: z.string().url(),
      headRefOid: z.string().nullable(),
    })
    .strict(),
  output: z.object({ message: z.string() }).strict(),
};

export const pullRequestContract = defineRpcContract({
  threadPullRequests: threadPullRequestsContract,
  refreshThreadPullRequest: refreshThreadPullRequestContract,
  threadPullRequestAction: threadPullRequestActionContract,
});
