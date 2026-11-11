/**
 * The target branch's history under the workspace's common base. Ported from
 * gitbutler (`src/shared/schema.ts` `baseHistorySchema`). Immutable for a
 * given base, so it is read once per base and never re-read on a timer.
 */
import { z } from "zod";

/** At most this many commits are listed under one base. */
export const BASE_HISTORY_MAX = 500;
/** And this many more each time the reader asks. */
export const BASE_HISTORY_PAGE = 20;

export const commitIdSchema = z.string().regex(/^[0-9a-f]{7,64}$/i);

export const baseCommitSchema = z
  .object({ id: z.string(), subject: z.string(), createdAt: z.string() })
  .strict();
export type BaseCommit = z.infer<typeof baseCommitSchema>;

export const baseHistorySchema = z
  .object({ commits: z.array(baseCommitSchema).max(BASE_HISTORY_MAX), hasMore: z.boolean() })
  .strict();
export type BaseHistory = z.infer<typeof baseHistorySchema>;
