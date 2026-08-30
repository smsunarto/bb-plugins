import type { z } from "zod";
import type {
  branchViewSchema,
  commitIntentSchema,
  hunkRevisionKeySchema,
  repositorySnapshotSchema,
} from "./domain.ts";

export type BranchView = z.infer<typeof branchViewSchema>;
export type CommitIntent = z.infer<typeof commitIntentSchema>;
export type HunkRevisionKey = z.infer<typeof hunkRevisionKeySchema>;
export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;
