// The backend's RPC contract, shared by server.ts and the sidebar bundle. bb's
// cached reads validate inputs and derive tags from it in the browser, so it
// lives apart from the backend's handlers and storage.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { MachineVisibilityChange } from "./machine-visibility.ts";

/**
 * Tags on the backend's cached reads. A write invalidates its tag in every
 * window: through the contract's `invalidates` for RPC writes, and through
 * `bb.rpc.experimental_invalidate` for changes the backend notices itself.
 */
export const GTD_TAGS = {
  lifecycle: "lifecycle",
  collapsed: "collapsed",
  machines: "machines",
  naming: "naming",
} as const;

const machineId = z.string().min(1);
export const machineVisibilityChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({
    kind: z.literal("set"),
    machineId,
    visible: z.boolean(),
    machineIds: z.array(machineId).min(1),
  }),
  z.object({ kind: z.literal("only"), machineId, machineIds: z.array(machineId).min(1) }),
]) satisfies z.ZodType<MachineVisibilityChange>;
const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });
const lifecycleRowsSchema = z.array(
  z.object({
    threadId: z.string(),
    snoozedUntil: z.number(),
    snoozedAt: z.number(),
  }),
);
const lifecycleWriteSchema = z.object({ ok: z.boolean(), rows: lifecycleRowsSchema });

export const gtdSidebarRpcContract = defineRpcContract({
  // Saving the hidden machines rather than the shown ones lets a machine bb
  // adds later show.
  listMachineVisibility: {
    experimental_description: "Machines hidden from the thread list, as host IDs.",
    input: z.object({}),
    output: z.object({ hiddenMachineIds: z.array(z.string()) }),
    tags: () => [GTD_TAGS.machines],
  },
  changeMachineVisibility: {
    experimental_description:
      "Show or hide one machine's threads, show only one machine, or show every machine.",
    input: machineVisibilityChangeSchema,
    output: z.object({ hiddenMachineIds: z.array(z.string()) }),
    invalidates: () => [GTD_TAGS.machines],
  },
  listNamingThreads: {
    experimental_description: "Threads whose title the plugin is currently generating.",
    input: z.object({}),
    output: z.array(z.string()),
    tags: () => [GTD_TAGS.naming],
  },
  listEnvironmentBranches: {
    experimental_description:
      "GitButler branch labels for plain (non-worktree) checkouts, when the setting is on.",
    input: z.object({ environmentIds: z.array(z.string().trim().min(1)).max(100) }),
    output: z.object({
      environments: z.array(
        z.object({
          environmentId: z.string(),
          label: z.string(),
        }),
      ),
    }),
  },
  listLifecycle: {
    experimental_description: "Every snoozed thread with its wake time.",
    input: z.object({}),
    output: z.object({ rows: lifecycleRowsSchema }),
    tags: () => [GTD_TAGS.lifecycle],
  },
  /** The built-in thread-list plugin's persisted family folds, shared by both sidebars. */
  listCollapsedThreads: {
    experimental_description:
      "Initialize unseen families as collapsed, then list folds shared with bb's own sidebar.",
    input: z.object({ familyIds: z.array(z.string().trim().min(1)).default([]) }),
    output: z.object({ threadIds: z.array(z.string()) }),
    tags: () => [GTD_TAGS.collapsed],
  },
  setThreadCollapsed: {
    experimental_description: "Fold or unfold one thread family.",
    input: z.object({ threadId: z.string().trim().min(1), collapsed: z.boolean() }),
    output: z.object({ threadIds: z.array(z.string()) }),
    invalidates: () => [GTD_TAGS.collapsed],
  },
  snooze: {
    experimental_description: "Park a thread and its family until an absolute wake time.",
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
    output: lifecycleWriteSchema,
    invalidates: () => [GTD_TAGS.lifecycle],
  },
  unsnooze: {
    experimental_description: "Wake a snoozed thread and its family now.",
    input: threadIdSchema,
    output: lifecycleWriteSchema,
    invalidates: () => [GTD_TAGS.lifecycle],
  },
  /**
   * bb's own re-parent, made by dropping one row onto another (nest) or onto
   * a project header (`parentThreadId: null`, back to the top level). The
   * sidebar hears the move through bb's thread feed, so nothing is
   * invalidated here. `reason` names the check a refused drop failed.
   */
  nestThread: {
    experimental_description: "Re-parent a thread under another thread, or back to the top level.",
    input: z.object({
      threadId: z.string().trim().min(1),
      parentThreadId: z.string().trim().min(1).nullable(),
    }),
    output: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  },
});
