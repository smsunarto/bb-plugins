import { z } from "zod";

/** The thread panel action id. The app registers it and the server opens a tab for it. */
export const PANEL_ACTION_ID = "gitbutler";
export const GITBUTLER_TAB = {
  id: PANEL_ACTION_ID,
  context: { kind: "thread" },
  availability: "action",
} as const;

/**
 * Realtime channel the server signals on when a workspace may have changed.
 * Every panel showing it reads it again instead of polling.
 */
export const WORKSPACE_CHANGED_CHANNEL = "workspace-changed";

/**
 * An agent's turn ended on an environment. Panels listen by environment,
 * because a subthread writes to its parent's. The thread that ended and its
 * parent say whose turn it was, so a panel credits files left behind only to
 * its own thread or a subthread of it.
 */
export const turnEndedSchema = z
  .object({
    environmentId: z.string(),
    threadId: z.string(),
    parentThreadId: z.string().nullable(),
  })
  .strict();

/**
 * A watched repository changed on disk, whoever changed it: the reader in a
 * terminal, GitButler desktop, or an agent. `checkouts` are the repository
 * paths on `hostId` whose boards it may have moved.
 */
export const repositoryChangedSchema = z
  .object({
    hostId: z.string(),
    commonDir: z.string(),
    checkouts: z.array(z.string()),
  })
  .strict();

export const workspaceChangedSchema = z.union([turnEndedSchema, repositoryChangedSchema]);

export type TurnEnded = z.infer<typeof turnEndedSchema>;
export type RepositoryChanged = z.infer<typeof repositoryChangedSchema>;
