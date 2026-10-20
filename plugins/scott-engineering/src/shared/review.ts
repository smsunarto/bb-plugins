import { z } from "zod";

export const modeSchema = z.enum(["quick", "standard", "deep"]);
export const kindSchema = z.enum(["design", "implementation"]);
export const revisionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/)
  .refine(
    (value) => !/^HEAD(?:$|[~^@])/.test(value) && !value.includes("gitbutler/workspace"),
    "Select a branch checkpoint or commit, not HEAD or gitbutler/workspace",
  );
export const targetSchema = z.union([
  z.object({ branch: revisionSchema }).strict(),
  z.object({ base: revisionSchema, head: revisionSchema }).strict(),
]);
export const pinnedTargetSchema = z.object({
  repositoryPath: z.string().min(1),
  branch: z.string().nullable(),
  base: z.string().regex(/^[a-f0-9]{40,64}$/),
  head: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export const requestSchema = z
  .object({
    kind: kindSchema.default("implementation"),
    mode: modeSchema.default("standard"),
    summary: z.string().trim().min(1).max(2000),
    target: targetSchema.optional(),
    brief: z.string().max(32768).optional(),
    evidence: z
      .array(
        z.object({ label: z.string().min(1).max(120), path: z.string().min(1).max(4096) }).strict(),
      )
      .max(8)
      .default([]),
  })
  .strict();
export const contextSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    section: z.enum(["diff", "tree", "file"]),
    path: z.string().min(1).max(4096).optional(),
    side: z.enum(["base", "head"]).default("head"),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export const resultSchema = z
  .object({
    threadId: z.string().min(1),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ReviewMode = z.infer<typeof modeSchema>;
export type ReviewKind = z.infer<typeof kindSchema>;
export type ReviewRequest = z.infer<typeof requestSchema>;
export type PinnedTarget = z.infer<typeof pinnedTargetSchema>;
export type ContextRequest = z.infer<typeof contextSchema>;
export type ResultRequest = z.infer<typeof resultSchema>;
export type Evidence = { label: string; path: string; text: string };
export type Reviewer = {
  providerId: "claude-code" | "codex";
  model: string;
  reasoningLevel: "medium" | "high" | "max";
  serviceTier: "fast";
};
// Static inputs attached to BB's reviewer thread; BB owns its lifecycle and output.
export const assignmentSchema = z.object({
  id: z.string(),
  mode: modeSchema,
  kind: kindSchema,
  summary: z.string(),
  target: pinnedTargetSchema.nullable(),
});
export type ReviewAssignment = z.infer<typeof assignmentSchema>;
