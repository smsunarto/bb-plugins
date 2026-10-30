import { z } from "zod";

/**
 * Realtime channels. bb broadcasts every publish to every client, so payloads
 * never carry document content. Live data reaches clients as RPC live reads
 * (`sessions`, `liveSession`), not on a channel.
 */
export const CHANNELS = {
  open: "whiteboard:open",
  settings: "whiteboard:settings",
} as const;

/**
 * Focus the Whiteboard tab in clients that show `threadId`. `at` identifies
 * the open and orders it per thread; `claimOpen` answers the same `at` for it.
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
