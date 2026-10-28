import { z } from "zod";

/** The fields Kitchen Sink reads from bb--git; additional host fields are omitted. */
const changeStats = z.object({
  insertions: z.number(),
  deletions: z.number(),
  fileCount: z.number(),
});
const unavailable = z.object({
  outcome: z.literal("unavailable"),
  failure: z.object({ message: z.string() }),
});
const notApplicable = z.object({ outcome: z.literal("not_applicable"), message: z.string() });

export const gitWorkspaceStatusSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    workspace: z.object({
      workingTree: changeStats,
      mergeBase: changeStats.extend({ mergeBaseBranch: z.string() }).nullable(),
      branch: z.object({
        currentBranch: z.string().nullable(),
        defaultBranch: z.string().nullable(),
      }),
    }),
  }),
  unavailable,
  notApplicable,
]);

export const gitDiffSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    diff: z.object({ diff: z.string(), truncated: z.boolean() }),
  }),
  unavailable,
  notApplicable,
]);

export type GitDiffTarget =
  | { type: "commit"; sha: string }
  | { type: "all"; mergeBaseBranch: string };
