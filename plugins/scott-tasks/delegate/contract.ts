import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema } from "../shared/contract";

const threadIdSchema = z.string().startsWith("thr_");

export const PARENT_NOTIFICATIONS = ["auto", "stuck", "off"] as const;

export const delegationRpcContract = defineRpcContract({
  delegate: {
    input: z
      .object({
        taskId: idSchema,
        presetId: idSchema,
        extraInstructions: z.string().optional(),
        /** Spawns the thread as this thread's child, so bb reports its turns to the parent. */
        parentThreadId: threadIdSchema.optional(),
        /**
         * The thread delegating, sent with the spawn as its sender. bb 0.50.1 uses
         * it only to count agent-started threads; the first message stays the user's.
         */
        senderThreadId: threadIdSchema.optional(),
        /** Which child turns bb reports to the parent; bb defaults to `auto`. Needs `parentThreadId`. */
        parentNotifications: z.enum(PARENT_NOTIFICATIONS).optional(),
        /** Starts a new worktree from this branch instead of the preset's environment. */
        baseBranch: z.string().trim().min(1).optional(),
        /**
         * Replaces the seed prompt's built-in report-back contract. Without it, a
         * `stuck` dispatch gets no contract, since its parent defines how to report.
         */
        reportContract: z.string().trim().min(1).optional(),
      })
      .strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
  taskThreadsAttach: {
    input: z
      .object({
        taskId: idSchema,
        threadId: threadIdSchema,
        /** Recorded as the thread's preset; a re-attach without one keeps the current name. */
        presetName: z.string().trim().min(1).optional(),
      })
      .strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
  taskThreadsDetach: {
    input: z.object({ taskId: idSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
});

export type DelegationRpcContract = typeof delegationRpcContract;
