// The backend's RPC contract, shared by server.ts and the sidebar bundle. bb's
// cached reads validate inputs and derive tags from it in the browser, so it
// lives apart from the backend's handlers and storage.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { MachineVisibilityChange } from "./machine-visibility.ts";

/**
 * Tags on the backend's cached reads. A write invalidates its tag in every
 * window: the backend calls `bb.rpc.experimental_invalidate` wherever the
 * data changes, so RPC, CLI and background writes refresh the same reads.
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
  /** Family folds, kept in the `expandedThreads` preference: families start folded. */
  listCollapsedThreads: {
    experimental_description: "List which of the given thread families are folded.",
    input: z.object({ familyIds: z.array(z.string().trim().min(1)).default([]) }),
    output: z.object({ threadIds: z.array(z.string()) }),
    tags: () => [GTD_TAGS.collapsed],
  },
  setThreadCollapsed: {
    experimental_description: "Fold or unfold one thread family.",
    input: z.object({ threadId: z.string().trim().min(1), collapsed: z.boolean() }),
    output: z.object({ expandedThreadIds: z.array(z.string()) }),
  },
  snooze: {
    experimental_description: "Park a thread and its family until an absolute wake time.",
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
    output: lifecycleWriteSchema,
  },
  unsnooze: {
    experimental_description: "Wake a snoozed thread and its family now.",
    input: threadIdSchema,
    output: lifecycleWriteSchema,
  },
});
