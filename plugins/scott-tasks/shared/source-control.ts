// A thread's pull request, read from Source Control's public keyed read
// `statusForThread` (plugins/source-control/src/contract/rpc.ts). The contract
// below mirrors only the methods Tasks calls, and leaves each row unparsed so
// one row in a shape Tasks doesn't know fails only that thread, not the read.
//
// Source Control serves stored rows. A row is read from its host while an app
// watches its key, which the detail view's keyed query does; the server's
// one-off read (for `bb tasks show`) asks for `refreshThread` instead.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SOURCE_CONTROL_PLUGIN_ID = "source-control";
/** Source Control's `MAX_THREAD_KEYS`. */
export const SOURCE_CONTROL_KEYS_PER_READ = 200;

const threadIdSchema = z.string().min(1).max(128);

export const sourceControlContract = defineRpcContract({
  statusForThread: {
    input: z.object({ keys: z.array(threadIdSchema).min(1).max(SOURCE_CONTROL_KEYS_PER_READ) }),
    output: z.record(z.string(), z.unknown()),
    // Source Control's `threadTag`: its invalidations name these tags.
    keyTags: (key: string) => [`thread:${key}`],
  },
  refreshThread: {
    input: z.object({ threadId: threadIdSchema }),
    output: z.unknown(),
  },
});

const pullRequestSchema = z.object({
  url: z.url(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
});

/** What the thread's pill shows: its pull request, with draft folded into `state`. */
export type ThreadPullRequestInfo = z.infer<typeof pullRequestSchema>;

// Whether Source Control's GitHub read for the Change has run, and how it
// went. Optional: a Source Control without it reports a missing PR as none.
const forgeStateSchema = z.object({
  state: z.enum(["unread", "read", "failed", "unsupported"]),
});

const statusRowSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("none") }),
  z.object({
    state: z.literal("change"),
    pullRequest: pullRequestSchema.nullable(),
    forge: forgeStateSchema.optional(),
  }),
]);

export type ThreadPullRequest =
  /** Source Control hasn't read the thread, or its pull request, yet. */
  | { kind: "pending" }
  /** The thread has no pull request, or no branch or checkout one could come from. */
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "pullRequest"; pullRequest: ThreadPullRequestInfo };

/** One `statusForThread` row as Tasks shows it; a missing or unknown row is unavailable. */
export function threadPullRequest(row: unknown): ThreadPullRequest {
  const parsed = statusRowSchema.safeParse(row);
  if (!parsed.success) return { kind: "unavailable" };
  const status = parsed.data;
  if (status.state === "pending") return { kind: "pending" };
  if (status.state === "none") return { kind: "absent" };
  // A failed read keeps the last good pull request, so a known one still shows.
  if (status.pullRequest !== null) return { kind: "pullRequest", pullRequest: status.pullRequest };
  switch (status.forge?.state) {
    case "unread":
      return { kind: "pending" };
    case "failed":
      return { kind: "unavailable" };
    default:
      return { kind: "absent" };
  }
}

/** Not read yet, or an open pull request GitHub may have moved on since Source Control last read it. */
export function mayHaveMoved(status: ThreadPullRequest | undefined): boolean {
  if (status?.kind === "pending") return true;
  if (status?.kind !== "pullRequest") return false;
  return status.pullRequest.state === "open" || status.pullRequest.state === "draft";
}
