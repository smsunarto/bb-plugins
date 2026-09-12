import { unityDiffSchema } from "@bb-plugins/unity-inspector/model";
import { z } from "zod";

export const CHANGED_CHANNEL = "latest-turn-changed";
export const changeSchema = z.object({
  id: z.string(),
  path: z.string(),
  patch: z.string().nullable(),
  added: z.number(),
  removed: z.number(),
  /** Foreign workspace label; absent means the change lives in the thread's own workspace. */
  workspace: z.string().optional(),
  /** Path relative to the owning workspace root, when it could be attributed. */
  relPath: z.string().optional(),
  /** The hunk header was synthesized client-side; line positions are unknown. */
  unpositioned: z.boolean().optional(),
});
export const latestTurnSchema = z
  .object({
    turnId: z.string(),
    anchorId: z.string().nullable(),
    patch: z.string().nullable(),
    changes: z.array(changeSchema),
    limited: z.boolean(),
    /** Label of the thread's own workspace, used as the local section header. */
    workspace: z.string().optional(),
    unity: z.record(z.string(), unityDiffSchema).optional(),
  })
  .nullable();
export type LatestTurn = NonNullable<z.infer<typeof latestTurnSchema>>;
export type Change = z.infer<typeof changeSchema>;
