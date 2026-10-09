import { z } from "zod";

/** The thread panel action id. The app registers it and the server opens a tab for it. */
export const PANEL_ACTION_ID = "gitbutler";

/**
 * Realtime channel the server signals on when an agent's turn ends on an
 * environment. Every panel showing that environment reads it again, so a
 * subthread's commits show in its parent's panel too. The thread that ended
 * and its parent say whose turn it was, so a panel credits files left behind
 * only to its own thread or a subthread of it.
 */
export const WORKSPACE_CHANGED_CHANNEL = "workspace-changed";

export const workspaceChangedSchema = z
  .object({
    environmentId: z.string(),
    threadId: z.string(),
    parentThreadId: z.string().nullable(),
  })
  .strict();

export type WorkspaceChanged = z.infer<typeof workspaceChangedSchema>;
