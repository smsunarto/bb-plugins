import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { editorHost, type UnityEditors } from "./unity-editors.ts";

export type EditorsContext = Readonly<{
  bb: BbPluginApi;
  unityEditors: UnityEditors;
  ensureLegacyClaims: () => Promise<void>;
}>;
export const editorActionSchema = z
  .object({
    action: z.enum([
      "list",
      "claim",
      "wait",
      "reserve",
      "request",
      "status",
      "release",
      "recover",
      "reconcile",
    ]),
    hostId: z.string().optional(),
    instanceId: z.string().optional(),
    claimId: z.string().optional(),
    /** The checkout a thread is about to open (reserve) or stop opening (release). */
    workspacePath: z.string().optional(),
    note: z.string().optional(),
    /** Why the Editor is needed; sent to its owner by `request`. */
    reason: z.string().max(500).optional(),
    confirmNoPendingWork: z.boolean().default(false),
    mode: z.enum(["runtime", "authoring"]).default("runtime"),
    /** Keep the claim or reservation past this thread's turn end. */
    hold: z.boolean().optional(),
    /** How long `wait` blocks for the Editor to free before failing. */
    timeoutSeconds: z.number().int().min(5).max(600).default(120),
  })
  .strict();
export async function editorAction(
  ctx: EditorsContext,
  input: z.infer<typeof editorActionSchema>,
  threadId?: string,
  signal?: AbortSignal,
) {
  await ctx.ensureLegacyClaims();
  const host = await editorHost(ctx.bb, threadId, input.hostId),
    service = ctx.unityEditors;
  if (input.action === "list") return service.list(host, signal, threadId);
  const reservationRelease =
    input.action === "release" && input.workspacePath && !input.instanceId && !input.claimId;
  if (input.action === "reserve" || reservationRelease)
    return reservationAction(service, host, input, owner(threadId), signal);
  const instanceId = resolveInstance(service, host, input, threadId);
  if (input.action === "recover")
    return service.recover(
      host,
      instanceId,
      input.confirmNoPendingWork && input.note?.trim() ? { note: input.note } : undefined,
      signal,
    );
  return ownedAction(service, host, instanceId, input, owner(threadId), signal);
}
function owner(threadId?: string) {
  if (!threadId) throw new Error("Ownership operations require an actual BB thread context");
  return threadId;
}
function resolveInstance(
  service: UnityEditors,
  host: string,
  input: z.infer<typeof editorActionSchema>,
  threadId?: string,
) {
  const instanceId =
    input.instanceId ??
    (input.claimId && threadId ? service.instanceFor(host, input.claimId, threadId) : undefined);
  if (!instanceId)
    throw new Error("instanceId is required. List Editors to select an exact instance.");
  return instanceId;
}
async function reservationAction(
  service: UnityEditors,
  host: string,
  input: z.infer<typeof editorActionSchema>,
  threadId: string,
  signal?: AbortSignal,
) {
  if (!input.workspacePath)
    throw new Error("workspacePath is required: the checkout whose Editor you are about to open");
  if (input.action === "reserve")
    return service.reserve(host, input.workspacePath, threadId, input.mode, input.hold, signal);
  return service.releaseReservation(host, input.workspacePath, threadId, signal);
}
async function ownedAction(
  service: UnityEditors,
  host: string,
  instanceId: string,
  input: z.infer<typeof editorActionSchema>,
  threadId: string,
  signal?: AbortSignal,
) {
  if (input.action === "claim" || input.action === "wait") {
    const options = { hold: input.hold };
    const claim =
      input.action === "claim"
        ? await service.claim(host, instanceId, threadId, input.mode, signal, options)
        : await service.wait(
            host,
            instanceId,
            threadId,
            input.mode,
            input.timeoutSeconds * 1000,
            signal,
            options,
          );
    return { ...claim, background: await service.quietFor(host, claim, signal) };
  }
  if (input.action === "request") {
    if (!input.reason?.trim())
      throw new Error("reason is required: tell the owner what you need the Editor for");
    return service.request(host, instanceId, threadId, input.mode, input.reason);
  }
  if (!input.claimId) throw new Error("claimId is required. Claim the Editor first.");
  if (input.action === "status")
    return service.status(host, instanceId, threadId, input.claimId, signal);
  if (input.action === "reconcile") {
    if (!input.confirmNoPendingWork || !input.note?.trim())
      throw new Error(
        "Reconciliation requires the owner's explicit confirmation and observed completion evidence",
      );
    return service.reconcile(host, instanceId, threadId, input.claimId, input.note, signal);
  }
  if (input.action === "release")
    return service.release(host, instanceId, threadId, input.claimId, signal);
  throw new Error("Unsupported Editor ownership action");
}
