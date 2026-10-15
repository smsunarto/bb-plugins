import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { slotInputs, slotResource } from "../../shared/slot-contract.ts";
import { unityHostContract } from "../../shared/unity-editor-contract.ts";
import { SlotStore, type Slot } from "./slot-store.ts";

export const slotProviderId = "unity-rampage-slot";

export function visibleSlot(slot: Slot, owner?: string) {
  const { leaseId: _leaseId, ...publicSlot } = slot;
  return owner && slot.ownerThreadId === owner ? slot : publicSlot;
}

/** Adopted Rampage checkouts survive releases, failed turns and environment retirement. */
export class UnitySlots {
  private readonly host;
  constructor(
    private readonly bb: BbPluginApi,
    readonly store: SlotStore,
    private readonly ensureLegacyClaims: () => Promise<void>,
  ) {
    this.host = bb.hosts.experimental_client({ contract: unityHostContract });
  }

  required(id: string, hostId?: string) {
    const slot = this.store.get(id);
    if (!slot || (hostId && slot.hostId !== hostId))
      throw new Error("Registered Rampage slot was not found on this host");
    return slot;
  }

  private async inspect(slot: Pick<Slot, "hostId" | "workspacePath">, signal?: AbortSignal) {
    const inspected = await this.host.call(
      "inspectWorkspace",
      { path: slot.workspacePath },
      {
        hostId: slot.hostId,
        signal,
      },
    );
    if (inspected.workspacePath !== slot.workspacePath)
      throw new Error("The registered checkout now resolves to a different directory");
  }

  async resolve(hostId: string, path: string, signal?: AbortSignal) {
    return (await this.host.call("resolveWorkspace", { path }, { hostId, signal })).workspacePath;
  }

  async verifyStopped(
    slot: Pick<Slot, "hostId" | "workspacePath" | "projectId">,
    owner?: string,
    signal?: AbortSignal,
  ) {
    await this.inspect(slot, signal);
    await this.host.call(
      "workspaceStopped",
      { path: slot.workspacePath },
      {
        hostId: slot.hostId,
        signal,
      },
    );
    // An adopted directory may already be attached to other BB environments.
    // Check every page; an idle thread can be admitted later through the dispatch hook.
    for (let offset = 0; ; offset += 100) {
      const environments = await this.bb.sdk.environments.list({
        hostId: slot.hostId,
        limit: 100,
        offset,
        signal,
      });
      for (const environment of environments) {
        if (!environment.path || environment.status === "destroyed") continue;
        if ((await this.resolve(slot.hostId, environment.path, signal)) !== slot.workspacePath)
          continue;
        if (environment.projectId !== slot.projectId)
          throw new Error("This checkout is attached to another BB project");
        if (
          environment.environmentProviderId &&
          !["project-checkout", slotProviderId].includes(environment.environmentProviderId)
        )
          throw new Error(
            "Adopt a persistent project checkout, not another provider's managed path",
          );
        await this.noOtherAgent(environment.id, owner, signal);
      }
      if (environments.length < 100) break;
    }
    signal?.throwIfAborted();
  }

  private async noOtherAgent(environmentId: string, owner?: string, signal?: AbortSignal) {
    for (let offset = 0; ; offset += 100) {
      const threads = await this.bb.sdk.threads.list({
        environmentId,
        archived: false,
        includeHidden: true,
        limit: 100,
        offset,
        signal,
      });
      const active = threads.find(
        (thread) =>
          thread.id !== owner && ["active", "starting", "stopping"].includes(thread.status),
      );
      if (active) throw new Error(`Checkout still has an active agent: @thread:${active.id}`);
      if (threads.length < 100) return;
    }
  }

  async register(hostId: string, path: string, projectId: string, signal?: AbortSignal) {
    await this.ensureLegacyClaims();
    await this.bb.sdk.projects.get({ projectId });
    const inspected = await this.host.call("inspectWorkspace", { path }, { hostId, signal });
    const existing = this.store.find(hostId, inspected.workspacePath);
    if (existing && existing.state !== "retired") {
      if (existing.projectId !== projectId) throw new Error("Slot belongs to another BB project");
      return existing;
    }
    // Block admission throughout adoption as well as later handoffs.
    const slot = this.store.db
      .transaction(() => {
        const registered = this.store.register(hostId, inspected.workspacePath, projectId);
        return this.store.beginRetire(registered.id, hostId, registered.workspacePath);
      })
      .immediate();
    try {
      await this.verifyStopped(slot, undefined, signal);
      return this.store.completeRelease(slot.id, slot.leaseId!);
    } catch (error) {
      this.store.quarantine(slot.id, slot.leaseId!, errorMessage(error));
      throw error;
    }
  }

  async acquire(
    id: string,
    hostId: string,
    projectId: string,
    owner: string,
    signal?: AbortSignal,
  ) {
    await this.ensureLegacyClaims();
    signal?.throwIfAborted();
    const previous = this.required(id, hostId);
    const slot = this.store.acquire(id, hostId, projectId, owner);
    if (previous.state === "leased" && previous.ownerThreadId === owner) return slot;
    return this.finishAcquisition(slot, owner, signal);
  }

  private async finishAcquisition(slot: Slot, owner: string, signal?: AbortSignal) {
    try {
      await this.verifyStopped(slot, owner, signal);
      return this.store.completeAcquire(slot.id, slot.leaseId!);
    } catch (error) {
      this.store.quarantine(slot.id, slot.leaseId!, errorMessage(error));
      throw error;
    }
  }

  private async excludedAutomaticPaths(hostId: string, projectId: string, signal?: AbortSignal) {
    const excluded = new Set<string>();
    // BB cannot adopt another provider's environment through create. Explicit slot
    // selection can reuse project-checkout environments through existingPath instead.
    for (let offset = 0; ; offset += 100) {
      const environments = await this.bb.sdk.environments.list({
        hostId,
        limit: 100,
        offset,
        signal,
      });
      const foreign = environments.filter(
        (environment) =>
          environment.path &&
          environment.status !== "destroyed" &&
          (environment.projectId !== projectId ||
            ![null, slotProviderId].includes(environment.environmentProviderId)),
      );
      for (const environment of foreign) {
        const path = await this.resolve(hostId, environment.path!, signal);
        if (path) excluded.add(path);
      }
      if (environments.length < 100) return excluded;
    }
  }

  /** Select and reserve one warm checkout; retries keep their existing slot. */
  async acquireFree(hostId: string, projectId: string, owner: string, signal?: AbortSignal) {
    await this.ensureLegacyClaims();
    signal?.throwIfAborted();
    const excluded = await this.excludedAutomaticPaths(hostId, projectId, signal);
    signal?.throwIfAborted();
    // Read ownership and reserve together, including across SQLite connections.
    // Host inspection starts only after this transaction has excluded other callers.
    const { slot, ready } = this.store.db
      .transaction(() => {
        const candidates = this.store
          .list(hostId)
          .filter((slot) => slot.projectId === projectId && !excluded.has(slot.workspacePath));
        const owned = candidates.find(
          (slot) => slot.ownerThreadId === owner && slot.state !== "retired",
        );
        const candidate = owned ?? candidates.find((slot) => slot.state === "available");
        if (!candidate)
          throw new Error(
            "No warm Rampage slot is available on this host and BB project. Create a slot or release one; adopted project checkouts require an explicit slotId.",
          );
        return {
          slot: this.store.acquire(candidate.id, hostId, projectId, owner),
          ready: candidate.state === "leased" && candidate.ownerThreadId === owner,
        };
      })
      .immediate();
    return ready ? slot : this.finishAcquisition(slot, owner, signal);
  }

  async release(id: string, owner: string, leaseId: string, signal?: AbortSignal) {
    await this.ensureLegacyClaims();
    const current = this.required(id);
    if (current.state === "available") return current;
    const slot = this.store.beginRelease(id, owner, leaseId);
    try {
      await this.verifyStopped(slot, owner, signal);
      return this.store.completeRelease(id, leaseId);
    } catch (error) {
      this.store.quarantine(id, leaseId, errorMessage(error));
      throw error;
    }
  }

  private async inactive(owner: string) {
    try {
      const thread = await this.bb.sdk.threads.get({ threadId: owner });
      return thread.archivedAt !== null || thread.deletedAt !== null;
    } catch (error) {
      if (z.object({ status: z.literal(404) }).safeParse(error).success) return true;
      throw error;
    }
  }

  async recover(id: string, caller: string | undefined, note: string, signal?: AbortSignal) {
    await this.ensureLegacyClaims();
    if (!note.trim()) throw new Error("Recovery requires observed completion evidence");
    const original = this.required(id);
    if (
      original.ownerThreadId &&
      original.ownerThreadId !== caller &&
      !(await this.inactive(original.ownerThreadId))
    )
      throw new Error(`Ask @thread:${original.ownerThreadId} to release its slot`);
    const slot = this.store.beginRecovery(id, original.leaseId);
    try {
      await this.verifyStopped(slot, caller, signal);
      if (
        original.ownerThreadId &&
        original.ownerThreadId !== caller &&
        !(await this.inactive(original.ownerThreadId))
      )
        throw new Error("The owning thread became active again during recovery");
      return { slot: this.store.completeRelease(id, slot.leaseId!), evidence: note };
    } catch (error) {
      this.store.quarantine(id, slot.leaseId!, errorMessage(error));
      throw error;
    }
  }

  async retire(id: string, hostId: string, path: string, signal?: AbortSignal) {
    await this.ensureLegacyClaims();
    const slot = this.store.beginRetire(id, hostId, path);
    if (slot.state === "retired") return slot;
    try {
      await this.verifyStopped(slot, undefined, signal);
      return this.store.completeRetire(id, slot.leaseId!);
    } catch (error) {
      this.store.quarantine(id, slot.leaseId!, errorMessage(error));
      throw error;
    }
  }

  install() {
    const prepare = async (context: {
      thread: { id: string };
      project: { id: string };
      host: { id: string };
      inputs: z.infer<typeof slotInputs>;
      signal: AbortSignal;
      experimental_claimPath(path: string): Promise<boolean>;
      report: { step(message: string): void };
      previous?: { environment: { path: string | null }; resource: unknown };
    }) => {
      try {
        context.report.step("Reserving the Rampage checkout");
        let slotId = context.inputs.slotId;
        if (context.previous) {
          const previous = context.previous;
          const resource =
            previous.resource === null ? null : slotResource.parse(previous.resource);
          const pinned = resource
            ? this.required(resource.slotId, context.host.id)
            : previous.environment.path
              ? this.store.find(context.host.id, previous.environment.path)
              : null;
          if (!pinned || (slotId && slotId !== pinned.id))
            throw new Error("Restore requires the original Rampage slot to remain registered");
          if (
            resource &&
            (resource.path !== pinned.workspacePath || resource.hostId !== pinned.hostId)
          )
            throw new Error("The environment resource does not match its original Rampage slot");
          slotId = pinned.id;
        }
        const slot = slotId
          ? await this.acquire(
              slotId,
              context.host.id,
              context.project.id,
              context.thread.id,
              context.signal,
            )
          : await this.acquireFree(
              context.host.id,
              context.project.id,
              context.thread.id,
              context.signal,
            );
        if (!(await context.experimental_claimPath(slot.workspacePath)))
          throw new Error("Another BB environment launch reserved this checkout path");
        return {
          status: "created" as const,
          path: slot.workspacePath,
          ownsPath: false,
          resource: { slotId: slot.id, hostId: slot.hostId, path: slot.workspacePath },
        };
      } catch (error) {
        return { status: "failed" as const, message: errorMessage(error) };
      }
    };
    this.bb.experimental_environments.register({
      id: slotProviderId,
      displayName: "Rampage Unity slot",
      description: "Reserve an available warm Rampage checkout and its private Unity Library cache",
      icon: "Folder",
      requires: { projectCheckout: true },
      inputs: slotInputs,
      policy: { retireGraceMs: null },
      validate: ({ inputs, host, project }) => {
        const slots = inputs.slotId ? [this.store.get(inputs.slotId)] : this.store.list(host.id);
        if (!slots.some((slot) => slot?.hostId === host.id && slot.projectId === project.id))
          return {
            action: "refuse",
            message: "Select a registered Rampage slot on this host and BB project",
          };
        return { action: "accept" };
      },
      // Existing project-checkout environments keep their persistent identity.
      // Admission below acquires the lease before a turn, even when create is skipped.
      experimental_existingPath: ({ slotId }) =>
        slotId ? (this.store.get(slotId)?.workspacePath ?? null) : null,
      create: prepare,
      restore: prepare,
      remove: async (context) => {
        // A failed/canceled launch may have no committed resource. Its lease remains
        // protected until explicit recovery; there is no provider-owned path to delete.
        if (context.resource === null) return { status: "removed" };
        try {
          const resource = slotResource.parse(context.resource);
          if (
            (context.hostId && context.hostId !== resource.hostId) ||
            (context.path && context.path !== resource.path)
          )
            throw new Error("Environment resource does not match its Rampage slot");
          await this.retire(resource.slotId, resource.hostId, resource.path, context.signal);
          return { status: "removed" };
        } catch (error) {
          return { status: "failed", message: errorMessage(error) };
        }
      },
    });
    this.bb.experimental_hooks.on("message.dispatch", (context) => this.admit(context));
  }

  async admit(context: MessageDispatchHookContext) {
    const { environment, thread, environmentIntent } = context;
    // BB gives hooks ten seconds; abort host/SDK inspection before that deadline.
    const signal = AbortSignal.timeout(7000);
    try {
      let slot: Slot | null = null;
      if (environment?.path) {
        if (!this.store.list(environment.hostId).length) return { action: "proceed" as const };
        const path = await this.resolve(environment.hostId, environment.path, signal);
        slot = path ? this.store.find(environment.hostId, path) : null;
      } else if (
        environmentIntent?.kind === "provider" &&
        environmentIntent.environmentProviderId === slotProviderId
      ) {
        const { slotId } = slotInputs.parse(environmentIntent.inputs);
        if (slotId) {
          slot = this.required(slotId, context.host?.id);
        } else {
          if (!context.host?.id) throw new Error("Select an existing host for a Rampage slot");
          await this.acquireFree(context.host.id, context.project.id, thread.id, signal);
          return { action: "proceed" as const };
        }
      }
      if (!slot) return { action: "proceed" as const };
      const hostId = environment?.hostId ?? context.host?.id;
      if (!hostId) throw new Error("Select the registered slot's existing host");
      await this.acquire(slot.id, hostId, context.project.id, thread.id, signal);
      if (
        environment?.path &&
        (await this.resolve(environment.hostId, environment.path, signal)) !== slot.workspacePath
      ) {
        throw new Error("The environment directory changed during slot admission");
      }
      return { action: "proceed" as const };
    } catch (error) {
      return { action: "reject" as const, message: errorMessage(error) };
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
