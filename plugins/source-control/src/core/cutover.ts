/**
 * What the cutover import reports: per kind of old data, how much it read,
 * imported, found already present, and skipped with the reason.
 */
import { z } from "zod";

export const IMPORT_KINDS = [
  "pins",
  "reviewInstructions",
  "viewedMarks",
  "branchIds",
  "prWatches",
  "landed",
  "reviewRuns",
  "threadBranches",
  "reviewRequests",
  "conflictResolutions",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const importCountSchema = z
  .object({
    read: z.number().int(),
    imported: z.number().int(),
    present: z.number().int(),
    skipped: z.record(z.string(), z.number().int()),
  })
  .strict();
export type ImportCount = z.infer<typeof importCountSchema>;

export const importReportSchema = z
  .object({
    /** Plugins whose export could not be read; their kinds are not in `counts`. */
    unavailable: z.array(z.object({ plugin: z.string(), reason: z.string() }).strict()),
    counts: z.record(z.string(), importCountSchema),
  })
  .strict();
export type ImportReport = z.infer<typeof importReportSchema>;
