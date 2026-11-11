/**
 * GitButler's operation log: a snapshot it takes before each write to a
 * workspace, newest first. Ported from `plugins/gitbutler/src/shared/schema.ts`.
 */
import { z } from "zod";

export const MAX_OPLOG = 200;

export const oplogEntrySchema = z
  .object({
    id: z.string(),
    /** GitButler's name for the kind of write, as in "CreateCommit". */
    operation: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type OplogEntry = z.infer<typeof oplogEntrySchema>;

export const oplogSchema = z.object({ entries: z.array(oplogEntrySchema).max(MAX_OPLOG) }).strict();
export type Oplog = z.infer<typeof oplogSchema>;
