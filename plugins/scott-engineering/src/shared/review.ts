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
    workstream: z.string().trim().min(1).max(120).optional(),
    summary: z.string().trim().min(1).max(2000),
    target: targetSchema.optional(),
    brief: z.string().max(32768).optional(),
    evidence: z
      .array(
        z.object({ label: z.string().min(1).max(120), path: z.string().min(1).max(4096) }).strict(),
      )
      .max(8)
      .default([]),
    reuse: z
      .union([z.enum(["auto", "new"]), z.object({ threadId: z.string().min(1) }).strict()])
      .default("auto"),
  })
  .strict();
export const contextSchema = z
  .object({
    runId: z.string().min(1),
    section: z.enum(["brief", "evidence", "diff", "tree", "file", "report"]),
    path: z.string().min(1).max(4096).optional(),
    side: z.enum(["base", "head"]).default("head"),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export const resultSchema = z
  .object({
    runId: z.string().min(1),
    waitSeconds: z.number().int().min(0).max(60).default(0),
  })
  .strict();
export type ReviewMode = z.infer<typeof modeSchema>;
export type ReviewKind = z.infer<typeof kindSchema>;
export type ReviewRequest = z.infer<typeof requestSchema>;
export type PinnedTarget = z.infer<typeof pinnedTargetSchema>;
export type ContextRequest = z.infer<typeof contextSchema>;
export type ResultRequest = z.infer<typeof resultSchema>;
export type Evidence = { label: string; path: string; text: string; sha256: string };
export type Reviewer = {
  providerId: "claude-code" | "codex";
  model: string;
  reasoningLevel: "medium" | "high" | "max";
  serviceTier: "fast";
};
/** One reviewer on the run's panel; turn ids and reads are scoped to its thread. */
export type Seat = {
  reviewer: Reviewer;
  threadId: string | null;
  afterSeq: number;
  queuedMessageId?: string;
  /** Set when a usage limit moved this seat, which then never falls back again. */
  fallback?: SeatFallback;
};
/** The exhausted assessment a seat left; BB's scheduled retries of `requestId` are cancelled. */
export type SeatFallback = {
  from: { reviewer: Reviewer; threadId: string; afterSeq: number };
  requestId: string;
  at: number;
};
export type ReviewRun = {
  id: string;
  contractVersion: number;
  parentThreadId: string;
  projectId: string;
  environmentId: string;
  hostId: string;
  environmentPath: string;
  seats: [Seat, ...Seat[]];
  request: ReviewRequest;
  target: PinnedTarget | null;
  evidence: Evidence[];
  fingerprint: string;
  startedAt: number;
  status: "starting" | "running" | "completed" | "incomplete" | "failed";
  error?: string;
};
