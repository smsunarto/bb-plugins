/**
 * The app ↔ server contract. `changeForThread` is a keyed read the app holds
 * through bb's tagged query hooks; it serves stored state and never calls a
 * host. The server refreshes rows only while a surface watches them.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  patchesSchema,
  patchSourceSchema,
  problemSchema,
  revisionSchema,
  threadChangeSchema,
  vcsActionSchema,
  vcsResultSchema,
} from "../core/change.ts";
import { threadTag } from "../core/ids.ts";

export const MAX_THREAD_KEYS = 200;

const threadIdSchema = z.string().min(1).max(128);

export const sourceControlContract = defineRpcContract({
  changeForThread: {
    experimental_description:
      "Each thread's Change, keyed by thread id: its checkout's branch state from the checkout host and its GitHub pull request, each with when it was last read and any current problem.",
    input: z.object({ keys: z.array(threadIdSchema).min(1).max(MAX_THREAD_KEYS) }).strict(),
    output: z.record(z.string(), threadChangeSchema),
    keyTags: (key: string) => [threadTag(key)],
  },
  refreshThread: {
    experimental_description:
      "Read the thread's checkout and pull request again now, and resolve once its row is current.",
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** File patches from the thread's checkout. A commit's never change; uncommitted ones refresh with the thread. */
  patches: {
    input: z.object({ threadId: threadIdSchema, source: patchSourceSchema }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: patchesSchema }).strict(),
      z.object({ ok: z.literal(false), problem: problemSchema }).strict(),
    ]),
    tags: (input: { threadId: string; source: { kind: string } }) =>
      input.source.kind === "uncommitted" ? [threadTag(input.threadId)] : [],
  },
  vcsAction: {
    experimental_description:
      "Push, pull or land on the thread's checkout, only if it is still at `expected`. Returns `conflict` and changes nothing otherwise. Never retried.",
    input: z
      .object({ threadId: threadIdSchema, action: vcsActionSchema, expected: revisionSchema })
      .strict(),
    output: vcsResultSchema,
  },
  /** Reads a GitButler workspace as plain git, or by what it is again. Stored per checkout. */
  setReadAs: {
    input: z.object({ threadId: threadIdSchema, readAs: z.enum(["auto", "git"]) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
