import { z } from "zod";

export const CHANGED_CHANNEL = "latest-turn-changed";
export const changeSchema = z.object({
  id: z.string(),
  path: z.string(),
  patch: z.string().nullable(),
  added: z.number(),
  removed: z.number(),
});
export const latestTurnSchema = z
  .object({
    turnId: z.string(),
    anchorId: z.string().nullable(),
    patch: z.string().nullable(),
    changes: z.array(changeSchema),
    limited: z.boolean(),
  })
  .nullable();
export type LatestTurn = NonNullable<z.infer<typeof latestTurnSchema>>;
export type Change = z.infer<typeof changeSchema>;
