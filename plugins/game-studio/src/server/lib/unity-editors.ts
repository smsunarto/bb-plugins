import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { uncertainJob, unityHostContract } from "../../shared/unity-editor-contract.ts";
import type {
  CommandParameters,
  CommandSubmission,
  EditorInstance,
  EditorQuietStatus,
  PipelineJob,
  VisibleEditorClaim,
} from "../../shared/unity-editor-contract.ts";
import { EditorClaims, type EditorMode, type EditorClaim } from "./unity-editor-store.ts";
import { checkoutSlots } from "./checkout-slots.ts";
import type { SlotStore } from "./slot-store.ts";
import { visibleSlot } from "./unity-slots.ts";

const runtimeCommands = new Set([
  "editor_status",
  "list_open_scenes",
  "get_console_logs",
  "get_scene_hierarchy",
  "find_gameobjects",
  "get_serialized_fields",
  "inspect_prefab",
  "project_map",
  "find_assets",
  "find_usages",
  "find_asset_references",
  "package_list",
  "package_search",
  "get_authoring_root",
]);
function usesHostFocus(command: string, parameters: CommandParameters): boolean {
  if (
    command.includes("focus") ||
    command.includes("capture") ||
    command.includes("screenshot") ||
    ["simulate_key", "simulate_pointer"].includes(command) ||
    (parameters.focus !== undefined && parameters.focus !== false)
  )
    return true;
  if (command !== "batch") return false;
  const operations = z
    .array(z.object({ command: z.string(), params: z.record(z.string(), z.json()).optional() }))
    .parse(parameters.operations);
  return operations.some((op) => usesHostFocus(op.command, op.params ?? {}));
}
export interface EditorTransport {
  discover(
    host: string,
    signal?: AbortSignal,
  ): Promise<{ instances: EditorInstance[]; warnings: string[] }>;
  probe(host: string, instance: EditorInstance, signal?: AbortSignal): Promise<{ pid: number }>;
  alive(host: string, instance: EditorInstance): Promise<{ alive: boolean }>;
  quiet(host: string, instance: EditorInstance, signal?: AbortSignal): Promise<EditorQuietStatus>;
  execute(
    host: string,
    instance: EditorInstance,
    command: string,
    parameters: CommandParameters,
    signal?: AbortSignal,
  ): Promise<CommandSubmission>;
  job(
    host: string,
    instance: EditorInstance,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<PipelineJob>;
}
/** How long one discovery answers inventory reads again. Each runs `unity status` on the host. */
export const DISCOVERY_MEMO_MS = 3_000;
type Discovery = Awaited<ReturnType<EditorTransport["discover"]>>;

export class UnityEditors {
  readonly claims: EditorClaims;
  private transport: EditorTransport;
  /** The latest inventory discovery per host, shared while it runs and for a few seconds after. */
  private discoveries = new Map<string, { at: number | null; promise: Promise<Discovery> }>();
  private ownerIsOrphan: (owner: string) => Promise<boolean>;
  constructor(
    claims: EditorClaims,
    transport: EditorTransport,
    ownerIsOrphan: (owner: string) => Promise<boolean> = async () => false,
  ) {
    this.claims = claims;
    this.transport = transport;
    this.ownerIsOrphan = ownerIsOrphan;
  }
  private owned(host: string, id: string, owner: string, claimId: string) {
    const claim = this.claims.owned(host, id, owner, claimId);
    if (!claim.orphaned) return claim;
    this.claims.markOrphan(owner, false);
    return this.claims.owned(host, id, owner, claimId);
  }
  private async assertJobFinished(host: string, claim: EditorClaim, signal?: AbortSignal) {
    if (!claim.jobId || claim.jobId === "uncertain") return;
    if (["verifying", "submitting"].includes(claim.jobId))
      throw new Error("A request is still in flight");
    const job = await this.transport.job(host, claim.instance, claim.jobId, signal);
    if (["queued", "running"].includes(job.state))
      throw new Error("The native job is still pending. Wait for it to finish.");
  }
  /** Studios and slot pickers poll the inventory; their reads share one recent discovery. */
  private recentDiscovery(host: string, signal?: AbortSignal): Promise<Discovery> {
    const kept = this.discoveries.get(host);
    let promise = kept?.promise;
    if (!kept || (kept.at !== null && Date.now() - kept.at >= DISCOVERY_MEMO_MS)) {
      const entry: { at: number | null; promise: Promise<Discovery> } = {
        at: null,
        // Shared by every caller, so no one caller's cancellation stops it.
        promise: this.transport.discover(host),
      };
      entry.promise.then(
        () => {
          entry.at = Date.now();
        },
        () => {
          if (this.discoveries.get(host) === entry) this.discoveries.delete(host);
        },
      );
      this.discoveries.set(host, entry);
      promise = entry.promise;
    }
    if (!signal) return promise!;
    signal.throwIfAborted();
    return Promise.race([
      promise!,
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ]);
  }
  async list(host: string, signal?: AbortSignal, owner?: string) {
    const discovered = await this.recentDiscovery(host, signal);
    const claims: VisibleEditorClaim[] = this.claims.list(host).map((claim) => {
      const { claimId: _claimId, ...publicClaim } = claim;
      return claim.ownerThreadId === owner ? claim : publicClaim;
    });
    return {
      hostId: host,
      ...discovered,
      claims,
      slots: checkoutSlots(
        host,
        discovered.instances,
        claims,
        this.claims.slots?.list(host).map((slot) => visibleSlot(slot, owner)),
      ),
    };
  }
  async claim(host: string, id: string, owner: string, mode: EditorMode, signal?: AbortSignal) {
    const { instances } = await this.transport.discover(host, signal);
    const instance = instances.find((i) => i.id === id);
    if (!instance) throw new Error("Editor is not in current discovery. List instances again.");
    if (instance.port === null && mode !== "authoring")
      throw new Error("A startup Editor needs an authoring claim for its own startup dialog");
    const { claim, created } = this.claims.claim(host, instance, owner, mode);
    const promoting = !created && claim.instance.port === null && instance.port !== null;
    if (promoting && claim.jobId) return this.owned(host, id, owner, claim.claimId);
    if (created || promoting) {
      if (promoting) this.claims.job(host, id, owner, claim.claimId, "verifying", null);
      try {
        if ((await this.transport.probe(host, instance, signal)).pid !== instance.pid)
          throw new Error("Editor PID verification failed");
      } catch (error) {
        this.claims.job(host, id, owner, claim.claimId, null, "verifying");
        if (created) this.claims.release(host, id, owner, claim.claimId);
        throw error;
      }
      if (promoting) this.claims.promote(host, id, owner, claim.claimId, instance);
      return this.claims.job(host, id, owner, claim.claimId, null, "verifying");
    }
    return this.owned(host, id, owner, claim.claimId);
  }
  async status(host: string, id: string, owner: string, claimId: string, signal?: AbortSignal) {
    let claim = this.owned(host, id, owner, claimId);
    if (!claim.jobId || ["verifying", "submitting", "uncertain"].includes(claim.jobId))
      return { claim, job: null };
    const job = await this.transport.job(host, claim.instance, claim.jobId, signal);
    const terminal = ["completed", "failed", "canceled"].includes(job.state);
    const background =
      terminal && !uncertainJob(job)
        ? await this.transport.quiet(host, claim.instance, signal)
        : null;
    if (terminal && (uncertainJob(job) || background?.quiet)) {
      claim = this.claims.job(
        host,
        id,
        owner,
        claimId,
        uncertainJob(job) ? "uncertain" : null,
        claim.jobId,
      );
    }
    return { claim, job, background };
  }
  async command(
    host: string,
    id: string,
    owner: string,
    claimId: string,
    command: string,
    parameters: CommandParameters,
    signal?: AbortSignal,
  ) {
    const claim = this.owned(host, id, owner, claimId);
    if (claim.instance.port === null)
      throw new Error(
        "A startup claim only covers its startup dialog. Rediscover and claim again after Pipeline starts.",
      );
    if (!runtimeCommands.has(command) && claim.mode !== "authoring")
      throw new Error(
        "This command needs an authoring claim on the main Editor; runtime claims permit inspection only",
      );
    if (
      usesHostFocus(command, parameters) &&
      this.claims.list(host).some((c) => c.ownerThreadId !== owner)
    )
      throw new Error("Host focus/capture is shared. Coordinate with other Editor owners first.");
    this.claims.begin(host, id, owner, claimId);
    if (!runtimeCommands.has(command)) {
      try {
        if (!(await this.transport.quiet(host, claim.instance, signal)).quiet)
          throw new Error("Editor has background work. Wait before another mutation.");
      } catch (error) {
        this.claims.job(host, id, owner, claimId, null, "submitting");
        throw error;
      }
    }
    try {
      const result = await this.transport.execute(
        host,
        claim.instance,
        command,
        parameters,
        signal,
      );
      if ("rejected" in result) {
        this.claims.job(host, id, owner, claimId, null, "submitting");
        throw new Error(result.error);
      }
      return this.claims.job(host, id, owner, claimId, result.jobId, "submitting");
    } catch (error) {
      this.claims.job(host, id, owner, claimId, "uncertain", "submitting");
      throw error;
    }
  }
  async reconcile(
    host: string,
    id: string,
    owner: string,
    claimId: string,
    note: string,
    signal?: AbortSignal,
  ) {
    const claim = this.owned(host, id, owner, claimId);
    await this.assertJobFinished(host, claim, signal);
    if (!(await this.transport.quiet(host, claim.instance, signal)).quiet)
      throw new Error("Editor is busy, reloading or blocked. Do not reconcile yet.");
    if (!note.trim()) throw new Error("Record the observed evidence that owned work has finished");
    const updated = this.claims.job(host, id, owner, claimId, null, claim.jobId);
    if (updated.jobId)
      throw new Error("Claim changed during reconciliation; inspect its current status");
    return { claim: updated, evidence: note };
  }
  async release(host: string, id: string, owner: string, claimId: string, signal?: AbortSignal) {
    const claim = this.claims.get(host, id);
    if (!claim) return { released: true };
    this.owned(host, id, owner, claimId);
    if (claim.jobId) throw new Error("Cannot release an Editor with pending or uncertain work");
    if (!(await this.transport.quiet(host, claim.instance, signal)).quiet)
      throw new Error("Editor has background work. Wait before releasing.");
    this.claims.release(host, id, owner, claimId);
    return { released: true };
  }
  async recover(host: string, id: string, confirmation?: { note: string }, signal?: AbortSignal) {
    let claim = this.claims.get(host, id);
    if (!claim) return { recovered: false };
    const editorAlive = (await this.transport.alive(host, claim.instance)).alive;
    if (editorAlive) {
      const inactive = await this.ownerIsOrphan(claim.ownerThreadId);
      this.claims.markOrphan(claim.ownerThreadId, inactive);
      const current = this.claims.get(host, id);
      if (current?.claimId !== claim.claimId) throw new Error("Claim changed during recovery");
      claim = current;
      if (!inactive)
        throw new Error(
          "The owning Editor process is still alive. Ask its owner to release; claims never expire automatically.",
        );
      if (!confirmation?.note.trim())
        throw new Error(
          "Orphan recovery requires explicit confirmation and observed completion evidence",
        );
      await this.assertJobFinished(host, claim, signal);
      if (!(await this.transport.quiet(host, claim.instance, signal)).quiet)
        throw new Error("Editor has background work; do not recover yet");
    }
    if (editorAlive && !(await this.ownerIsOrphan(claim.ownerThreadId))) {
      this.claims.markOrphan(claim.ownerThreadId, false);
      throw new Error("Owner became active during recovery");
    }
    signal?.throwIfAborted();
    this.claims.recover(host, id, claim.claimId, claim.jobId, editorAlive);
    return { recovered: true, evidence: confirmation?.note };
  }
}
export function createUnityEditors(bb: BbPluginApi, slots?: SlotStore) {
  const host = bb.hosts.experimental_client({ contract: unityHostContract });
  const service = new UnityEditors(
    new EditorClaims(bb.storage.database(), slots),
    {
      discover: (hostId, signal) => host.call("discover", {}, { hostId, signal }),
      probe: (hostId, instance, signal) => host.call("probe", { instance }, { hostId, signal }),
      alive: (hostId, instance) =>
        host.call("alive", { pid: instance.pid, startedAt: instance.startedAt }, { hostId }),
      quiet: (hostId, instance, signal) => host.call("quiet", { instance }, { hostId, signal }),
      execute: (hostId, instance, command, parameters, signal) =>
        host.call("execute", { instance, command, parameters }, { hostId, signal }),
      job: (hostId, instance, jobId, signal) =>
        host.call("job", { instance, jobId }, { hostId, signal }),
    },
    async (owner) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId: owner });
        return thread.archivedAt != null || thread.deletedAt != null;
      } catch (error) {
        if (z.object({ status: z.literal(404) }).safeParse(error).success) return true;
        throw error;
      }
    },
  );
  bb.events.on("thread.deleted", ({ thread }) => service.claims.markOrphan(thread.id));
  bb.events.on("thread.archived", ({ thread }) => service.claims.markOrphan(thread.id));
  bb.events.on("thread.unarchived", ({ thread }) => service.claims.markOrphan(thread.id, false));
  return service;
}
export async function editorHost(bb: BbPluginApi, threadId: string | undefined, hostId?: string) {
  if (hostId) return hostId;
  if (!threadId) throw new Error("Supply --host outside a BB thread");
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) throw new Error("This thread has no host environment");
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  return environment.hostId;
}
