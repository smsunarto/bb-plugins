import { z } from "zod";

/**
 * Realtime channels. bb broadcasts every publish to every client, so payloads
 * never carry document content. Live data reaches clients as RPC live reads
 * (`sessions`, `liveSession`), not on a channel.
 */
export const CHANNELS = {
  settings: "whiteboard:settings",
} as const;

export const settingsPayload = z.object({
  scratchpadEnabled: z.boolean(),
  softwareMapEnabled: z.boolean(),
});
export type SettingsPayload = z.infer<typeof settingsPayload>;
