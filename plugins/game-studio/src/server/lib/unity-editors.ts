import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { uncertainJob, unityHostContract } from "../../shared/unity-editor-contract.ts";
import type {
  EditorInstance,
  EditorQuietStatus,
  EditorReservation,
  PipelineJob,
  VisibleEditorClaim,
} from "../../shared/unity-editor-contract.ts";
import {
  ClaimConflictError,
  EditorClaims,
  type ClaimOptions,
  type EditorMode,
  type EditorClaim,
} from "./unity-editor-store.ts";
import { checkoutSlots } from "./checkout-slots.ts";
import type { SlotStore } from "./slot-store.ts";
import { visibleSlot } from "./unity-slots.ts";

export interface EditorTransport {
  discover(
    host: string,
    signal?: AbortSignal,
  ): Promise<{ instances: EditorInstance[]; warnings: string[] }>;
  probe(host: string, instance: EditorInstance, signal?: AbortSignal): Promise<{ pid: number }>;
  alive(host: string, instance: EditorInstance): Promise<{ alive: boolean }>;
  quiet(host: string, instance: EditorInstance, signal?: AbortSignal): Promise<EditorQuietStatus>;
  /** Read pre-upgrade jobs only so existing claims can finish their handoff. */
  job(
    host: string,
    instance: EditorInstance,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<PipelineJob>;
  /** Canonical checkout directory for a reservation; without it the given path is used as-is. */
  resolveWorkspace?(
    host: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ workspacePath: string | null }>;
}
export interface OwnerStatus {
  status: string;
  updatedAt: number;
}
/** BB-side lookups the service needs for conflicts, handoff requests and turn-end release. */
export interface UnityEditorsHooks {
  ownerStatus?: (owner: string) => Promise<OwnerStatus | null>;
  /** Deliver a handoff request to the owning thread's next turn. */
  send?: (owner: string, text: string) => Promise<void>;
}
/** How long one discovery answers inventory reads again. Each runs `unity status` on the host. */
export const DISCOVERY_MEMO_MS = 3_000;
/** A waiting claim re-checks at least this often, besides waking on every release. */
export const WAIT_POLL_MS = 5_000;
/** A busy Editor's turn-end release retries at this interval, for up to the give-up window. */
export const AUTO_RELEASE_RETRY_MS = 15_000;
export const AUTO_RELEASE_GIVE_UP_MS = 30 * 60_000;
/** Repeated handoff requests to one owner wait this long between messages. */
export const REQUEST_INTERVAL_MS = 60_000;
type Discovery = Awaited<ReturnType<EditorTransport["discover"]>>;

/** A conflict the caller can wait out, request a handoff for, or route around. */
export class EditorConflictError extends Error {
  readonly owner: string;
  readonly ownerStatus: OwnerStatus | null;
  constructor(message: string, owner: string, ownerStatus: OwnerStatus | null) {
    super(message);
    this.name = "EditorConflictError";
    this.owner = owner;
    this.ownerStatus = ownerStatus;
  }
}

export class UnityEditors {
  readonly claims: EditorClaims;
  private transport: EditorTransport;
  /** The latest inventory discovery per host, shared while it runs and for a few seconds after. */
  private discoveries = new Map<string, { at: number | null; promise: Promise<Discovery> }>();
  private ownerIsOrphan: (owner: string) => Promise<boolean>;
  private hooks: UnityEditorsHooks;
  private waiters = new Set<() => void>();
  private autoReleases = new Map<string, ReturnType<typeof setTimeout>>();
  private requests = new Map<string, number>();
  constructor(
    claims: EditorClaims,
    transport: EditorTransport,
    ownerIsOrphan: (owner: string) => Promise<boolean> = async () => false,
    hooks: UnityEditorsHooks = {},
  ) {
    this.claims = claims;
    this.transport = transport;
    this.ownerIsOrphan = ownerIsOrphan;
    this.hooks = hooks;
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
    const reservations = this.claims.reservations(host);
    return {
      hostId: host,
      ...discovered,
      claims,
      reservations,
      slots: checkoutSlots(
        host,
        discovered.instances,
        claims,
        this.claims.slots?.list(host).map((slot) => visibleSlot(slot, owner)),
        reservations,
      ),
    };
  }
  /** A failed BB lookup must not change what a conflict or release decides. */
  private async ownerStatus(owner: string): Promise<OwnerStatus | null> {
    try {
      return (await this.hooks.ownerStatus?.(owner)) ?? null;
    } catch {
      return null;
    }
  }
  /** Turn a store conflict into advice: who holds it, what they are doing, and the ways out. */
  private async conflict(error: unknown): Promise<never> {
    if (!(error instanceof ClaimConflictError)) throw error;
    const status = await this.ownerStatus(error.owner);
    throw new EditorConflictError(
      `${error.message}.${describeOwner(status, error.holder)} Options: action "wait" with the same instanceId and mode blocks until it frees; action "request" with a reason asks the owner to release; or open your own worktree Editor.`,
      error.owner,
      status,
    );
  }
  async claim(
    host: string,
    id: string,
    owner: string,
    mode: EditorMode,
    signal?: AbortSignal,
    options: ClaimOptions = {},
  ) {
    const { instances } = await this.transport.discover(host, signal);
    const instance = instances.find((i) => i.id === id);
    if (!instance) throw new Error("Editor is not in current discovery. List instances again.");
    if (instance.port === null && mode !== "authoring")
      throw new Error("A startup Editor needs an authoring claim for its own startup dialog");
    const { claim, created } = await this.record(host, instance, owner, mode, options);
    this.cancelAutoRelease(host, id);
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
  private async record(
    host: string,
    instance: EditorInstance,
    owner: string,
    mode: EditorMode,
    options: ClaimOptions,
  ) {
    try {
      return this.claims.claim(host, instance, owner, mode, options);
    } catch (error) {
      return this.conflict(error);
    }
  }
  /** Claim once the Editor frees, waking on every release and re-checking at least every poll. */
  async wait(
    host: string,
    id: string,
    owner: string,
    mode: EditorMode,
    timeoutMs: number,
    signal?: AbortSignal,
    options: ClaimOptions = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.claim(host, id, owner, mode, signal, options);
      } catch (error) {
        if (!(error instanceof EditorConflictError)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new EditorConflictError(
            `Timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} waiting. ${error.message}`,
            error.owner,
            error.ownerStatus,
          );
        await this.waitForChange(Math.min(remaining, WAIT_POLL_MS), signal);
      }
    }
  }
  private waitForChange(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        reject(signal?.reason);
      };
      const timer = setTimeout(wake, ms);
      this.waiters.add(wake);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private notifyWaiters() {
    for (const wake of this.waiters) wake();
  }
  private async workspaceFor(host: string, path: string, signal?: AbortSignal) {
    const resolved = this.transport.resolveWorkspace
      ? (await this.transport.resolveWorkspace(host, path, signal)).workspacePath
      : path;
    if (!resolved) throw new Error("The workspace path does not exist on the host");
    return resolved;
  }
  /** Hold a checkout before `unity open`, so the Editor is owned from its first discovery. */
  async reserve(
    host: string,
    path: string,
    owner: string,
    mode: EditorMode,
    hold?: boolean,
    signal?: AbortSignal,
  ): Promise<EditorReservation> {
    const workspacePath = await this.workspaceFor(host, path, signal);
    try {
      return this.claims.reserve(host, workspacePath, owner, mode, hold);
    } catch (error) {
      return this.conflict(error);
    }
  }
  async releaseReservation(host: string, path: string, owner: string, signal?: AbortSignal) {
    const workspacePath = await this.workspaceFor(host, path, signal);
    try {
      const released = this.claims.releaseReservation(host, workspacePath, owner);
      if (released) this.notifyWaiters();
      return { released, workspacePath };
    } catch (error) {
      return this.conflict(error);
    }
  }
  /** Ask the owning thread for a handoff; it decides when its work is safe to pause. */
  async request(host: string, id: string, requester: string, mode: EditorMode, reason: string) {
    const claim = this.claims.get(host, id);
    if (!claim) throw new Error("No thread owns this Editor; claim it directly.");
    if (claim.ownerThreadId === requester) throw new Error("This thread already owns the Editor");
    if (!this.hooks.send)
      throw new Error("Thread messaging is unavailable here; use bb thread tell on the owner");
    const key = `${host}:${id}:${requester}`;
    const last = this.requests.get(key);
    if (last && Date.now() - last < REQUEST_INTERVAL_MS)
      throw new Error(
        `A handoff request went to @thread:${claim.ownerThreadId} ${Math.round((Date.now() - last) / 1000)} s ago. Wait for its reply or use action "wait".`,
      );
    const ownerStatus = await this.ownerStatus(claim.ownerThreadId);
    await this.hooks.send(claim.ownerThreadId, handoffRequest(requester, claim, mode, reason));
    this.requests.set(key, Date.now());
    const { claimId: _claimId, ...publicClaim } = claim;
    return { requested: true, owner: claim.ownerThreadId, ownerStatus, claim: publicClaim };
  }
  async status(host: string, id: string, owner: string, claimId: string, signal?: AbortSignal) {
    let claim = this.owned(host, id, owner, claimId);
    if (!claim.jobId || ["verifying", "submitting", "uncertain"].includes(claim.jobId))
      return { claim, job: null, background: await this.quietFor(host, claim, signal) };
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
    return {
      claim,
      job: {
        jobId: job.jobId,
        state: job.state,
        error: job.error ?? null,
        uncertain: uncertainJob(job),
      },
      background,
    };
  }
  /** Native idle state for a connected claim without a legacy job; null otherwise. */
  async quietFor(host: string, claim: EditorClaim, signal?: AbortSignal) {
    return !claim.jobId && claim.instance.port !== null
      ? await this.transport.quiet(host, claim.instance, signal)
      : null;
  }
  /** The Editor behind one of the caller's claim ids. */
  instanceFor(host: string, claimId: string, owner: string) {
    const claim = this.claims.byClaimId(host, claimId);
    if (!claim || claim.ownerThreadId !== owner)
      throw new Error("A matching claim owned by this BB thread is required");
    return claim.instance.id;
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
    this.cancelAutoRelease(host, id);
    this.notifyWaiters();
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
    this.cancelAutoRelease(host, id);
    this.notifyWaiters();
    return { recovered: true, evidence: confirmation?.note };
  }
  /** The owner's turn ended: drop its reservations and release its unheld claims once quiet. */
  async ownerIdle(owner: string) {
    let changed = false;
    for (const reservation of this.claims.reservationsBy(owner)) {
      if (reservation.hold) continue;
      changed =
        this.claims.releaseReservation(reservation.hostId, reservation.workspacePath, owner) ||
        changed;
    }
    if (changed) this.notifyWaiters();
    await Promise.all(
      this.claims
        .ownedBy(owner)
        .filter((claim) => !claim.hold && !claim.jobId)
        .map((claim) => this.tryAutoRelease(claim, Date.now())),
    );
  }
  /** The owner started a new turn: whatever release was still pending is theirs to decide. */
  ownerActive(owner: string) {
    for (const claim of this.claims.ownedBy(owner)) {
      this.cancelAutoRelease(claim.hostId, claim.instance.id);
      if (claim.autoRelease)
        this.claims.autoRelease(claim.hostId, claim.instance.id, owner, claim.claimId, false);
    }
  }
  /** Retry every release that a plugin reload interrupted. */
  async sweepAutoReleases() {
    await Promise.all(
      this.claims
        .all()
        .filter((claim) => claim.autoRelease === "pending")
        .map((claim) => this.tryAutoRelease(claim, Date.now())),
    );
  }
  private autoReleaseKey(host: string, id: string) {
    return `${host}:${id}`;
  }
  private cancelAutoRelease(host: string, id: string) {
    const key = this.autoReleaseKey(host, id);
    const timer = this.autoReleases.get(key);
    if (timer) clearTimeout(timer);
    this.autoReleases.delete(key);
  }
  private async tryAutoRelease(claim: EditorClaim, startedAt: number) {
    const { hostId: host, ownerThreadId: owner, claimId } = claim;
    const id = claim.instance.id;
    this.cancelAutoRelease(host, id);
    const current = this.claims.get(host, id);
    if (!current || current.claimId !== claimId || current.hold || current.jobId) return;
    let quiet = true;
    if (current.instance.port !== null) {
      try {
        quiet = (await this.transport.quiet(host, current.instance)).quiet;
      } catch {
        quiet = false;
      }
    }
    // The owner may have started another turn while the Editor was being checked.
    const status = await this.ownerStatus(owner);
    const latest = this.claims.get(host, id);
    if (!latest || latest.claimId !== claimId || latest.hold || latest.jobId) return;
    if (status && ["active", "starting"].includes(status.status)) {
      if (latest.autoRelease) this.claims.autoRelease(host, id, owner, claimId, false);
      return;
    }
    if (quiet) {
      try {
        this.claims.release(host, id, owner, claimId);
      } catch {
        return;
      }
      this.notifyWaiters();
      return;
    }
    if (!latest.autoRelease) this.claims.autoRelease(host, id, owner, claimId, true);
    if (Date.now() - startedAt >= AUTO_RELEASE_GIVE_UP_MS) return;
    const timer = setTimeout(
      () => void this.tryAutoRelease(claim, startedAt),
      AUTO_RELEASE_RETRY_MS,
    );
    timer.unref?.();
    this.autoReleases.set(this.autoReleaseKey(host, id), timer);
  }
  dispose() {
    for (const timer of this.autoReleases.values()) clearTimeout(timer);
    this.autoReleases.clear();
    this.notifyWaiters();
  }
}
function describeOwner(status: OwnerStatus | null, holder: EditorClaim | EditorReservation) {
  if (!status) return "";
  if (status.status !== "idle") return ` The owner thread is ${status.status}.`;
  const minutes = Math.max(0, Math.round((Date.now() - status.updatedAt) / 60_000));
  const why =
    "hold" in holder && holder.hold
      ? "held deliberately across its turns"
      : "autoRelease" in holder && holder.autoRelease
        ? "releasing as soon as its Editor is quiet"
        : "about to release";
  return ` The owner thread has been idle for ${minutes} min; the claim is ${why}.`;
}
function handoffRequest(requester: string, claim: EditorClaim, mode: EditorMode, reason: string) {
  const instance = claim.instance;
  return [
    `[Editor handoff request] @thread:${requester} needs a ${mode} claim on the Unity Editor at ${instance.projectPath} (pid ${instance.pid}), which you own in ${claim.mode} mode since ${claim.claimedAt}.`,
    `Reason: ${reason.trim()}`,
    `When your current step can pause: finish or wait for native work, keep dirty scenes unsaved, then release with game_studio_manage action "release" and claimId ${claim.claimId} (CLI: bb game-studio manage release --instance ${instance.id} --claim ${claim.claimId}).`,
    `If you must keep it, reply with an ETA: bb thread tell ${requester} --mode steer '<when you will release>'. Claims release automatically when your turn ends unless held.`,
  ].join("\n");
}
export function createUnityEditors(bb: BbPluginApi, slots?: SlotStore) {
  const host = bb.hosts.experimental_client({ contract: unityHostContract });
  const thread = async (owner: string) => {
    try {
      return await bb.sdk.threads.get({ threadId: owner });
    } catch (error) {
      if (z.object({ status: z.literal(404) }).safeParse(error).success) return null;
      throw error;
    }
  };
  const service = new UnityEditors(
    new EditorClaims(bb.storage.database(), slots),
    {
      discover: (hostId, signal) => host.call("discover", {}, { hostId, signal }),
      probe: (hostId, instance, signal) => host.call("probe", { instance }, { hostId, signal }),
      alive: (hostId, instance) =>
        host.call("alive", { pid: instance.pid, startedAt: instance.startedAt }, { hostId }),
      quiet: (hostId, instance, signal) => host.call("quiet", { instance }, { hostId, signal }),
      job: (hostId, instance, jobId, signal) =>
        host.call("job", { instance, jobId }, { hostId, signal }),
      resolveWorkspace: (hostId, path, signal) =>
        host.call("resolveWorkspace", { path }, { hostId, signal }),
    },
    async (owner) => {
      const found = await thread(owner);
      return !found || found.archivedAt != null || found.deletedAt != null;
    },
    {
      ownerStatus: async (owner) => {
        const found = await thread(owner);
        return found ? { status: found.status, updatedAt: found.updatedAt } : null;
      },
      send: async (owner, text) => {
        await bb.sdk.threads.send({
          threadId: owner,
          mode: "steer-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
      },
    },
  );
  bb.events.on("thread.deleted", ({ thread }) => {
    service.claims.markOrphan(thread.id);
    void service.ownerIdle(thread.id);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    service.claims.markOrphan(thread.id);
    void service.ownerIdle(thread.id);
  });
  bb.events.on("thread.unarchived", ({ thread }) => service.claims.markOrphan(thread.id, false));
  bb.events.on("thread.idle", ({ thread }) => void service.ownerIdle(thread.id));
  bb.events.on("thread.failed", ({ thread }) => void service.ownerIdle(thread.id));
  bb.events.on("thread.active", ({ thread }) => service.ownerActive(thread.id));
  bb.onDispose(() => service.dispose());
  void service.sweepAutoReleases();
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
