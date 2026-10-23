import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { slotSchema, slotProvisionInput, slotProvisionResult } from "./slot-contract.ts";

export const editorSchema = z
  .object({
    id: z.string(),
    projectPath: z.string(),
    workspacePath: z.string(),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535).nullable(),
    version: z.string(),
    startedAt: z.string(),
    clone: z.boolean(),
  })
  .strict();
export type EditorInstance = z.infer<typeof editorSchema>;
export const editorModeSchema = z.enum(["runtime", "authoring"]);
export const visibleClaimSchema = z
  .object({
    instance: editorSchema,
    hostId: z.string(),
    ownerThreadId: z.string(),
    claimId: z.string().optional(),
    mode: editorModeSchema,
    jobId: z.string().nullable(),
    claimedAt: z.string(),
    operationLoadId: z.string().optional(),
    orphaned: z.boolean().optional(),
    /** Kept across the owner's idle turns; otherwise the claim releases itself at turn end. */
    hold: z.boolean().optional(),
    /** The owner's turn ended while the Editor was busy; release retries until it is quiet. */
    autoRelease: z.literal("pending").optional(),
  })
  .strict();
export type VisibleEditorClaim = z.infer<typeof visibleClaimSchema>;
/** A thread's intent to open an Editor on a checkout before discovery can list it. */
export const reservationSchema = z
  .object({
    hostId: z.string(),
    workspacePath: z.string(),
    ownerThreadId: z.string(),
    mode: editorModeSchema,
    hold: z.boolean().optional(),
    reservedAt: z.string(),
  })
  .strict();
export type EditorReservation = z.infer<typeof reservationSchema>;
export const checkoutSlotSchema = z
  .object({
    id: z.string(),
    hostId: z.string(),
    workspacePath: z.string(),
    mainEditors: z.array(editorSchema),
    mppmEditors: z.array(editorSchema),
    claims: z.array(visibleClaimSchema),
    reservations: z.array(reservationSchema),
    lifecycle: slotSchema.optional(),
  })
  .strict();
export type CheckoutSlot = z.infer<typeof checkoutSlotSchema>;
export const editorInventorySchema = z
  .object({
    hostId: z.string(),
    instances: z.array(editorSchema),
    warnings: z.array(z.string()),
    claims: z.array(visibleClaimSchema),
    reservations: z.array(reservationSchema),
    slots: z.array(checkoutSlotSchema),
  })
  .strict();
export const pipelineJobSchema = z
  .object({
    jobId: z.string(),
    state: z.enum(["queued", "running", "completed", "failed", "canceled"]),
    result: z.json().optional(),
    error: z.string().nullable().optional(),
    errorDetails: z.string().nullable().optional(),
  })
  .passthrough();
export type PipelineJob = z.infer<typeof pipelineJobSchema>;
export const editorQuietSchema = z
  .object({
    quiet: z.boolean(),
    blocking: z
      .object({ source: z.string().max(64), status: z.string().max(128) })
      .strict()
      .optional(),
  })
  .strict();
export type EditorQuietStatus = z.infer<typeof editorQuietSchema>;
export const unityHostContract = defineRpcContract({
  planSlotDestination: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ workspacePath: z.string() }).strict(),
  },
  provisionSlot: {
    input: slotProvisionInput,
    output: slotProvisionResult,
  },
  resolveWorkspace: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ workspacePath: z.string().nullable() }).strict(),
  },
  inspectWorkspace: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ workspacePath: z.string(), projectVersion: z.string() }).strict(),
  },
  workspaceStopped: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ stopped: z.literal(true) }).strict(),
  },
  discover: {
    input: z.object({}).strict(),
    output: z.object({ instances: z.array(editorSchema), warnings: z.array(z.string()) }).strict(),
  },
  probe: {
    input: z.object({ instance: editorSchema }).strict(),
    output: z.object({ pid: z.number().int() }).strict(),
  },
  alive: {
    input: z.object({ pid: z.number().int().positive(), startedAt: z.string() }).strict(),
    output: z.object({ alive: z.boolean() }).strict(),
  },
  quiet: {
    input: z.object({ instance: editorSchema }).strict(),
    output: editorQuietSchema,
  },
  job: {
    input: z.object({ instance: editorSchema, jobId: z.string() }).strict(),
    output: pipelineJobSchema,
  },
});

export function uncertainJob(job: PipelineJob): boolean {
  let nested: unknown = job.result;
  if (typeof nested === "string") {
    try {
      nested = JSON.parse(nested);
    } catch {
      nested = null;
    }
  }
  const scriptFailure = z
    .object({
      success: z.literal(false),
      error: z.string().nullable().optional(),
      errorDetails: z.string().nullable().optional(),
    })
    .safeParse(nested);
  const failure = [
    job.error,
    job.errorDetails,
    scriptFailure.success ? scriptFailure.data.error : null,
    scriptFailure.success ? scriptFailure.data.errorDetails : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    job.uncertain === true ||
    job.state === "canceled" ||
    job.error === "Timeout" ||
    (scriptFailure.success && scriptFailure.data.error === "Timeout") ||
    /timed out|keeps running detached|did not complete within.*budget/i.test(failure)
  );
}
