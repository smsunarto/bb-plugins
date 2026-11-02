import { z } from "zod";

/**
 * Realtime channel the server publishes on when a thread's workspace may have
 * changed. The app plays the completion sound when a top-level thread becomes `idle`.
 */
export const WORKSPACE_CHANGED_CHANNEL = "workspace-changed";

export const workspaceChangedSignalSchema = z
  .object({
    threadId: z.string().min(1),
    parentThreadId: z.string().min(1).nullable(),
    reason: z.literal("idle"),
  })
  .strict();

export type WorkspaceChangedSignal = z.output<typeof workspaceChangedSignalSchema>;

/** Plugin http route (under `/api/v1/plugins/<id>/http`) that serves the turn completion sound. */
export const COMPLETION_SOUND_PATH = "/completion-sound";
