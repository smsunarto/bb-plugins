import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { jsonParametersSchema } from "../../shared/unity-editor-contract.ts";
import { editorHost, type UnityEditors } from "./unity-editors.ts";

export type EditorsContext = Readonly<{
  bb: BbPluginApi;
  unityEditors: UnityEditors;
  ensureLegacyClaims: () => Promise<void>;
}>;
export const editorActionSchema = z
  .object({
    action: z.enum(["list", "claim", "status", "command", "release", "recover", "reconcile"]),
    hostId: z.string().optional(),
    instanceId: z.string().optional(),
    claimId: z.string().optional(),
    note: z.string().optional(),
    confirmNoPendingWork: z.boolean().default(false),
    mode: z.enum(["runtime", "authoring"]).default("runtime"),
    command: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
      .optional(),
    parameters: z.string().default("{}").describe("Unity command parameters as JSON object text"),
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
  if (!input.instanceId)
    throw new Error("instanceId is required. List Editors to select an exact instance.");
  if (input.action === "recover")
    return service.recover(
      host,
      input.instanceId,
      input.confirmNoPendingWork && input.note?.trim() ? { note: input.note } : undefined,
      signal,
    );
  if (!threadId) throw new Error("Ownership operations require an actual BB thread context");
  if (input.action === "claim")
    return service.claim(host, input.instanceId, threadId, input.mode, signal);
  if (!input.claimId) throw new Error("claimId is required. Claim the Editor first.");
  if (input.action === "status")
    return service.status(host, input.instanceId, threadId, input.claimId, signal);
  if (input.action === "reconcile") {
    if (!input.confirmNoPendingWork || !input.note?.trim())
      throw new Error(
        "Reconciliation requires the owner's explicit confirmation and observed completion evidence",
      );
    return service.reconcile(host, input.instanceId, threadId, input.claimId, input.note, signal);
  }
  if (input.action === "release") {
    return service.release(host, input.instanceId, threadId, input.claimId, signal);
  }
  if (!input.command) throw new Error("command is required");
  return service.command(
    host,
    input.instanceId,
    threadId,
    input.claimId,
    input.command,
    jsonParametersSchema.parse(JSON.parse(input.parameters)),
    signal,
  );
}
