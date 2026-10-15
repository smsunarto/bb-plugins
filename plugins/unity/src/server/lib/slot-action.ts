import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { slotActionSchema } from "../../shared/slot-contract.ts";
import { editorHost } from "./unity-editors.ts";
import { UnitySlots, visibleSlot } from "./unity-slots.ts";

export type SlotsContext = Readonly<{
  bb: BbPluginApi;
  unitySlots: UnitySlots;
  ensureLegacyClaims: () => Promise<void>;
}>;

export async function slotAction(
  ctx: SlotsContext,
  input: z.infer<typeof slotActionSchema>,
  threadId?: string,
  signal?: AbortSignal,
) {
  await ctx.ensureLegacyClaims();
  const hostId = await editorHost(ctx.bb, threadId, input.hostId);
  const service = ctx.unitySlots;
  if (input.action === "list")
    return {
      slots: service.store
        .list(hostId)
        .filter((slot) => !input.projectId || slot.projectId === input.projectId)
        .map((slot) => visibleSlot(slot, threadId)),
    };
  if (input.action === "register") {
    if (!input.path) throw new Error("Registration requires path and projectId");
    const projectId = await registrationProject(ctx.bb, input.projectId, threadId);
    return visibleSlot(await service.register(hostId, input.path, projectId, signal), threadId);
  }
  if (!input.slotId) throw new Error("slotId is required; list registered slots first");
  const slot = service.required(input.slotId, hostId);
  if (input.action === "retire")
    return visibleSlot(await service.retire(slot.id, hostId, slot.workspacePath, signal));
  if (input.action === "recover") {
    if (!input.confirmNoPendingWork || !input.note?.trim())
      throw new Error("Recovery requires explicit confirmation and observed completion evidence");
    const recovered = await service.recover(slot.id, threadId, input.note, signal);
    return { ...recovered, slot: visibleSlot(recovered.slot, threadId) };
  }
  if (!threadId) throw new Error("Slot ownership requires an actual BB thread context");
  if (input.action === "release") {
    if (!input.leaseId) throw new Error("leaseId is required; acquire the slot first");
    return visibleSlot(await service.release(slot.id, threadId, input.leaseId, signal), threadId);
  }
  const thread = await ctx.bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) throw new Error("This thread has no checkout environment");
  const environment = await ctx.bb.sdk.environments.get({ environmentId: thread.environmentId });
  if (
    environment.hostId !== hostId ||
    !environment.path ||
    (await service.resolve(hostId, environment.path, signal)) !== slot.workspacePath
  )
    throw new Error(
      "Acquire a slot from a thread attached to that checkout or select its environment provider",
    );
  return service.acquire(slot.id, hostId, thread.projectId, threadId, signal);
}

async function registrationProject(bb: BbPluginApi, projectId?: string, threadId?: string) {
  if (projectId) return projectId;
  if (!threadId) throw new Error("Registration requires path and projectId");
  return (await bb.sdk.threads.get({ threadId })).projectId;
}
