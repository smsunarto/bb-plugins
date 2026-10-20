import { z } from "zod";

export const MAX_ROUNDS = 3;
/** One name per worker role, shared by the card and worker thread titles. */
export function roleLabel(
  role: "frame" | "candidate" | "judge" | "synthesis",
  candidate: number | null,
) {
  if (role === "candidate") return `Candidate ${(candidate ?? 0) + 1}`;
  return role === "frame" ? "Plan" : role === "judge" ? "Review" : "Combine";
}
export const terminal = new Set(["completed", "failed", "stopped"]);
/** Phases in which every worker of the run, result rewrites included, must stop and stay stopped. */
export const cancelled = new Set(["stopping", "failing", "stopped", "failed"]);
const text = z.string().min(1).max(8000);
export const startSchema = z
  .object({
    task: z.string().min(1).max(32000),
    requestId: z.string().min(1).max(200),
  })
  .strict();
export const lookupSchema = z.object({ runId: z.uuid() }).strict();
export const scopedLookupSchema = lookupSchema.extend({ threadId: z.string().min(1) });
export const modelSchema = z.object({
  providerId: z.enum(["codex", "claude-code"]),
  model: z.string().min(1),
  reasoningLevel: z.enum(["medium", "high", "xhigh", "max"]),
  serviceTier: z.enum(["default", "fast"]),
});
export type Model = z.infer<typeof modelSchema>;
export const frameSchema = z
  .object({
    kind: z.literal("frame"),
    summary: text,
    rubric: z.array(z.string().min(1).max(1000)).min(3).max(6),
    verification: z.array(z.string().min(1).max(2000)).min(1).max(8),
  })
  .strict();
export const candidateSchema = z
  .object({
    kind: z.literal("candidate"),
    summary: text,
    tradeoff: text,
  })
  .strict();
export const judgeSchema = z
  .object({
    kind: z.literal("judge"),
    summary: text,
    preferredCandidate: z.number().int().min(0).max(1),
    scores: z
      .array(
        z
          .object({
            candidate: z.number().int().min(0).max(1),
            criteria: z
              .array(z.object({ score: z.number().min(0).max(5), rationale: text }).strict())
              .min(3)
              .max(6),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    reframe: z.boolean(),
  })
  .strict();
export const synthesisSchema = z
  .object({
    kind: z.literal("synthesis"),
    summary: text,
    baseCandidate: z.number().int().min(0).max(1),
    rationale: text,
    grafts: z
      .array(z.object({ candidate: z.number().int().min(0).max(1), change: text }).strict())
      .max(8),
    rejected: z.array(text).max(8),
    checks: z
      .array(
        z
          .object({
            command: z.string().min(1).max(2000),
            exitCode: z.number().int(),
            output: z.string().max(12000),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const reportSchema = z.discriminatedUnion("kind", [
  frameSchema,
  candidateSchema,
  judgeSchema,
  synthesisSchema,
]);
export type Report = z.infer<typeof reportSchema>;
export const submitSchema = lookupSchema.extend({ report: reportSchema }).strict();
export const jobSchema = z.object({
  key: z.string(),
  round: z.number().int().min(1).max(MAX_ROUNDS),
  role: z.enum(["frame", "candidate", "judge", "synthesis"]),
  candidate: z.number().int().min(0).max(1).nullable(),
  model: modelSchema,
  dispatch: z.enum(["reserved", "dispatching", "started", "retired"]),
  /** A retired launch has no worker left to stop: its worker stopped, or a restart found none. */
  stopConfirmed: z.boolean().optional(),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  path: z.string().nullable(),
  commit: z.string().nullable(),
  report: reportSchema.nullable(),
  outcome: z.enum(["running", "completed", "failed"]),
  error: z.string().nullable(),
  retried: z.boolean(),
});
export type Job = z.infer<typeof jobSchema>;
export const commandResultSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  output: z.string(),
});
export const integrationSchema = z.object({
  status: z.enum(["integrated", "verification-failed", "conflict", "changed", "interrupted"]),
  summary: z.string(),
  checks: z.array(commandResultSchema),
});
export type Integration = z.infer<typeof integrationSchema>;
export const preparationSchema = z.object({
  status: z.literal("prepared"),
  proposalCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  sourceTree: z.string().regex(/^[a-f0-9]{40,64}$/),
  combinedTree: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export const preparationResultSchema = z.union([preparationSchema, integrationSchema]);
export type Preparation = z.infer<typeof preparationSchema>;
export const runSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  requestId: z.string(),
  task: z.string(),
  parentThreadId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  hostId: z.string(),
  root: z.string(),
  base: z.string().nullable(),
  snapshotId: z.uuid().optional(),
  preparation: preparationSchema.nullable().default(null),
  feedback: z
    .object({ summary: z.string(), integration: integrationSchema.nullable() })
    .nullable()
    .default(null),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).default("accept-edits"),
  models: z.tuple([modelSchema, modelSchema]),
  lead: modelSchema,
  round: z.number().int().min(1).max(MAX_ROUNDS),
  recoveryAttempts: z.number().int().min(0).max(3).default(0),
  phase: z.enum([
    "snapshot",
    "framing",
    "candidates",
    "judging",
    "synthesizing",
    "integrating",
    "stopping",
    "failing",
    "completed",
    "failed",
    "stopped",
  ]),
  jobs: z.array(jobSchema),
  integration: integrationSchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
export type ArenaRun = z.infer<typeof runSchema>;
export const runOutputSchema = z.object({ run: runSchema });
/** A plain-language rewrite of a candidate's or the synthesis's result, shown on the card. */
export const readableSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("candidate"), summary: text, tradeoff: text }).strict(),
  z
    .object({
      kind: z.literal("synthesis"),
      summary: text,
      rationale: text,
      grafts: z.array(text).max(8),
      rejected: z.array(text).max(8),
    })
    .strict(),
]);
export type Readable = z.infer<typeof readableSchema>;
export const digestSchema = z.object({
  jobKey: z.string(),
  threadId: z.string().nullable(),
  status: z.enum(["running", "done", "failed"]),
  result: readableSchema.nullable(),
  startedAt: z.number(),
});
export type Digest = z.infer<typeof digestSchema>;
export const cardOutputSchema = runOutputSchema.extend({ digests: z.array(digestSchema) });
