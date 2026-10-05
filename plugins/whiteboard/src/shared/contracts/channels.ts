import { z } from "zod";

/**
 * Realtime channels (design §3.3). bb broadcasts every publish to every client,
 * so payloads never carry document content; clients refetch what they show.
 */
export const CHANNELS = {
  changed: "whiteboard:changed",
  open: "whiteboard:open",
  settings: "whiteboard:settings",
} as const;

/** One invalidation. `coverage` and `worktree` match every review subscription. */
export const changedPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("review"),
    reviewId: z.string(),
    version: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("activity"), reviewId: z.string() }),
  z.object({ kind: z.literal("catalog") }),
  z.object({ kind: z.literal("coverage") }),
  z.object({ kind: z.literal("worktree"), repositoryId: z.string() }),
]);
export type ChangedPayload = z.infer<typeof changedPayload>;

/**
 * Focus the Whiteboard tab in clients that show `threadId` (design §3.6).
 * `at` identifies the open and orders it per thread; `claimOpen` answers the
 * same `at` for it.
 */
export const openPayload = z.object({
  threadId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  at: z.number(),
});
export type OpenPayload = z.infer<typeof openPayload>;

export const settingsPayload = z.object({
  scratchpadEnabled: z.boolean(),
  softwareMapEnabled: z.boolean(),
});
export type SettingsPayload = z.infer<typeof settingsPayload>;

/** The coalescing window for `whiteboard:changed`, per key. */
export const CHANGED_COALESCE_MS = 50;
