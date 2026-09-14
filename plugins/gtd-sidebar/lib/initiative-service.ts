// Initiative lifecycle on top of bb's native threads: coordinator creation,
// agent dispatch, ancestry-based membership, and the synchronous role hints
// bb.agents.configure/contributeInstructions need.
//
// Membership is bb's parentThreadId ancestry — read live from core, never
// persisted here. The descendant index is an in-memory projection of that
// ancestry so the synchronous agent-configuration hooks can answer "is this
// thread part of an initiative" without an async walk.
import type { BbPluginApi, PluginProviderReasoningLevel } from "@get-bb/plugin-sdk";
import {
  INITIATIVES_CHANNEL,
  type Initiative,
  type InitiativeAgent,
  type InitiativeRole,
  type InitiativeWorkspace,
  type InitiativeWorkspaceBinding,
  type SharedDirectoryWorkspacePreview,
} from "./initiative-types.ts";
import {
  normalizeContextPath,
  type InitiativeStore,
  type WriteDocResult,
} from "./initiative-store.ts";
import type {
  InspectSharedDirectoryInput,
  InspectSharedDirectoryOutput,
} from "./shared-directory-host.ts";
import {
  createInitiativeWorkspaceResolver,
  type PreviewInitiativeWorkspaceInput,
} from "./initiative-workspace.ts";

type Threads = Pick<
  BbPluginApi["sdk"]["threads"],
  "spawn" | "send" | "get" | "list" | "update" | "delete" | "archive" | "unarchive"
>;
type SpawnEnvironment = Parameters<Threads["spawn"]>[0]["environment"];
type Projects = Pick<BbPluginApi["sdk"]["projects"], "get" | "list">;
type Hosts = Pick<BbPluginApi["sdk"]["hosts"], "get">;
type Log = Pick<BbPluginApi["log"], "info" | "warn" | "error">;

/** Deeper than any real delegation tree; stops a corrupt ancestry from looping. */
const ANCESTOR_LIMIT = 64;
/** One initiative's roster stays a page, not a table scan; past this the list is flagged truncated. */
const AGENT_LIMIT = 512;
const LIST_PAGE_SIZE = 200;
const LIST_PAGE_LIMIT = 25;
/** Keep workspace preparation inside an ordinary UI RPC budget. */
const ENVIRONMENT_RESOLUTION_TIMEOUT_MS = 10_000;
const ENVIRONMENT_RESOLUTION_POLL_MS = 50;

export interface InitiativeServiceDeps {
  store: InitiativeStore;
  threads: Threads;
  projects: Projects;
  hosts: Hosts;
  inspectSharedDirectory(
    hostId: string,
    input: InspectSharedDirectoryInput,
  ): Promise<InspectSharedDirectoryOutput>;
  /** The owning plugin id ("gtd-sidebar") — used to recognize our own spawns. */
  pluginId: string;
  publish(channel: string, payload: unknown): void;
  log: Log;
  /** `bb.experimental_hooks.recheck("message.dispatch")` — re-attempts held dispatches. */
  recheckDispatch(): Promise<void>;
  /** Test seam for the bounded native provisioning poll. */
  environmentResolution?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?(): number;
    wait?(milliseconds: number): Promise<void>;
  };
}

/**
 * Marker prefix carried in an agent-only input block of an initiative's first
 * message. The message.dispatch gate holds any dispatch wearing it until the
 * registry/index can resolve the thread's membership, so the provider session
 * the message starts is born already configured.
 */
export const INITIATIVE_INIT_MARKER = "initiative-init:v1:";

export interface InitiativeDispatchGateContext {
  threadId: string;
  parentThreadId: string | null;
  /** Hook-provided origin plugin id — markers only count when it is ours. */
  originPluginId: string | null;
  /** Raw prompt blocks; the gate only reads agent-only marker text. */
  inputBlocks: readonly { type: string; text?: string; visibility?: string }[];
}

export type DispatchGateDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string }
  | { action: "reject"; message: string };

export interface CreateInitiativeInput {
  name: string;
  icon?: string;
  description?: string;
  workspaceProjectIds: string[];
  /** Omitted remains the shipped legacy per-repository behavior. */
  workspace?: InitiativeWorkspace;
  environmentId?: string | null;
  environmentProviderId?: string | null;
  providerId?: string | null;
  model?: string | null;
  reasoningLevel?: string | null;
  initialPrompt?: string;
}

export interface SpawnAgentInput {
  initiativeId: string;
  prompt: string;
  title?: string;
  projectId?: string;
  environmentId?: string | null;
  environmentProviderId?: string | null;
  providerId?: string | null;
  model?: string | null;
  reasoningLevel?: string | null;
}

export interface AgentListResult {
  agents: InitiativeAgent[];
  /** True when the roster hit AGENT_LIMIT — the UI must not show it as complete. */
  truncated: boolean;
}

export interface InitiativeMembership {
  /**
   * Synchronous role hint for the agent-configuration hooks, which cannot
   * await an ancestry walk. Answers coordinator / agent / not-a-member from
   * the coordinator set and the descendant index — the dispatch gate keeps
   * the index warm ahead of every session it admits.
   */
  roleHint(threadId: string, parentThreadId: string | null): InitiativeRole | null;
  /** The initiative a descendant belongs to, if the index knows it. */
  descendantInitiative(threadId: string): string | null;
}

export interface InitiativeService {
  previewInitiativeWorkspace(
    input: PreviewInitiativeWorkspaceInput,
  ): Promise<SharedDirectoryWorkspacePreview>;
  createInitiative(
    input: CreateInitiativeInput,
  ): Promise<{ initiative: Initiative; threadId: string }>;
  updateInitiative(
    initiativeId: string,
    patch: Parameters<InitiativeStore["update"]>[1],
  ): Initiative;
  /**
   * Archive applies bb's real thread archive to the coordinator and every
   * live descendant (restorable), then flips the registry flag so the
   * subscription engine pauses. Unarchive reverses it.
   */
  setArchived(initiativeId: string, archived: boolean): Promise<Initiative>;
  /** Removes registry + docs; subscriptions are the caller's (engine's) job. Threads stay bb's. */
  deleteInitiative(initiativeId: string): void;
  spawnAgent(input: SpawnAgentInput): Promise<{ threadId: string }>;
  attachThread(initiativeId: string, threadId: string): Promise<void>;
  detachThread(initiativeId: string, threadId: string): Promise<void>;
  /** Ancestry walk: thread itself a coordinator, or descended from one. */
  resolveThread(threadId: string): Promise<{ initiative: Initiative; role: InitiativeRole } | null>;
  /** Live descendants of the coordinator, breadth-first. Rebuilds the index for this initiative. */
  listAgents(initiative: Initiative): Promise<AgentListResult>;
  /** Core's view of the coordinator thread; unavailable when deleted or gone. */
  coordinatorSnapshot(
    initiative: Initiative,
  ): Promise<{ status: string | null; available: boolean }>;
  /**
   * Admission decision for `message.dispatch`: holds marked first messages
   * until membership is committed, indexes unmarked children of members, and
   * rejects marked orphans that outlived a failed initialization.
   */
  dispatchGate(ctx: InitiativeDispatchGateContext): Promise<DispatchGateDecision>;
  /**
   * The single context-doc mutation boundary for RPC and agent tools: store
   * write + realtime publish on success. A CAS conflict publishes nothing.
   */
  writeContextDoc(input: {
    initiativeId: string;
    path: string;
    content: string;
    expectedRevision?: number;
    updatedBy?: string;
  }): WriteDocResult;
  /** Deletes a doc or directory prefix and publishes the change. */
  deleteContextDoc(initiativeId: string, path: string): number;
  /**
   * Mirrors a native lifecycle change on the coordinator row into the
   * registry: archiving/restoring the coordinator through ordinary thread
   * surfaces (GTD settle, raw bb) pauses/resumes the initiative's
   * subscriptions in step, and deleting it publishes the change so the UI
   * surfaces "coordinator unavailable" — never a silent respawn. Events the
   * service's own archive/restore emits are ignored (lifecycleSync).
   */
  noteNativeThreadState(threadId: string, state: "archived" | "unarchived" | "deleted"): void;
  /**
   * Index a newly created thread synchronously — the thread.created event
   * fires before the first session is constructed, so indexing here is what
   * lets a descendant's FIRST turn resolve its role and instructions.
   */
  noteThreadCreated(thread: { id: string; parentThreadId: string | null }): void;
  membership: InitiativeMembership;
}

export function createInitiativeService(deps: InitiativeServiceDeps): InitiativeService {
  const {
    store,
    threads,
    projects,
    hosts,
    inspectSharedDirectory,
    pluginId,
    publish,
    log,
    recheckDispatch,
    environmentResolution,
  } = deps;
  const previewInitiativeWorkspace = createInitiativeWorkspaceResolver({
    projects,
    hosts,
    inspectSharedDirectory,
  });

  const coordinatorIds = new Set(store.coordinatorThreadIds());
  /** Init nonces whose registry/index commit is still in flight. */
  const pendingInits = new Set<string>();
  /**
   * Initiatives whose archive/restore loop is emitting native thread events
   * right now; noteNativeThreadState ignores those so our own mutations never
   * re-enter the registry flip.
   */
  const lifecycleSync = new Set<string>();

  // Providers concatenate input blocks without adding separators. Keep this
  // exact plugin envelope on its own paragraph so a literal reply-only prompt
  // cannot become `DONEinitiative-init:...`, and do not interpret arbitrary
  // agent-only prompt text that merely contains the marker prefix.
  const MARKER_RE =
    /^\n\n<!-- initiative-init:v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}); plugin-internal initialization metadata; not part of the task; do not reproduce -->\n\n$/;
  const markerNonce = (blocks: InitiativeDispatchGateContext["inputBlocks"]): string | null => {
    for (const block of blocks) {
      if (
        block.type === "text" &&
        block.visibility === "agent-only" &&
        typeof block.text === "string"
      ) {
        const nonce = block.text.match(MARKER_RE)?.[1];
        if (nonce !== undefined) return nonce;
      }
    }
    return null;
  };

  const markedInput = (prompt: string, nonce: string, agentOnlyPrompt: boolean) => [
    {
      type: "text" as const,
      text: prompt,
      mentions: [],
      ...(agentOnlyPrompt ? { visibility: "agent-only" as const } : {}),
    },
    {
      type: "text" as const,
      // The leading and trailing blank lines are data, not formatting in a
      // caller: providers concatenate this block directly after the prompt.
      text: `\n\n<!-- ${INITIATIVE_INIT_MARKER}${nonce}; plugin-internal initialization metadata; not part of the task; do not reproduce -->\n\n`,
      mentions: [],
      visibility: "agent-only" as const,
    },
  ];
  /** threadId -> initiativeId for known descendants; rebuilt by listAgents. */
  const descendantIndex = new Map<string, string>();

  const personalProjectId = async (): Promise<string> => {
    const all = await projects.list({ includePersonal: true });
    const personal = all.find((project) => project.kind === "personal");
    if (personal === undefined) throw new Error("no personal project found");
    return personal.id;
  };

  const environmentSpec = (
    environmentId: string | null | undefined,
    environmentProviderId: string | null | undefined,
  ) => {
    if (environmentId != null && environmentId !== "") {
      return { type: "reuse" as const, environmentId };
    }
    if (environmentProviderId != null && environmentProviderId !== "") {
      return { type: "provider" as const, environmentProviderId, inputs: null };
    }
    return { type: "project-default" as const };
  };

  const requireInitiative = (initiativeId: string): Initiative => {
    const initiative = store.get(initiativeId);
    if (initiative === null) throw new Error(`initiative ${initiativeId} not found`);
    return initiative;
  };

  const requireActive = (initiative: Initiative): void => {
    if (initiative.archivedAt !== null) {
      throw new Error(`initiative ${initiative.id} is archived`);
    }
  };

  const hasEnvironmentOverride = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && value !== "";

  const validatePersistedSharedWorkspace = async (initiative: Initiative): Promise<void> => {
    if (initiative.workspace.mode !== "shared-directory") return;
    const bindings = store.workspaceBindings(initiative.id);
    const host = await hosts.get({ hostId: initiative.workspace.hostId }).catch(() => null);
    if (host === null || host.status !== "connected") {
      throw new Error(`shared workspace machine ${initiative.workspace.hostId} is unavailable`);
    }
    let inspection: InspectSharedDirectoryOutput;
    try {
      inspection = await inspectSharedDirectory(initiative.workspace.hostId, {
        repositoryPaths: bindings.map((binding) => binding.path ?? ""),
        rootPath: initiative.workspace.rootPath,
      });
    } catch (cause) {
      throw new Error(
        `shared workspace paths could not be validated: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (
      inspection.root?.kind !== "directory" ||
      inspection.root.canonicalPath !== initiative.workspace.rootPath
    ) {
      throw new Error(
        `shared workspace root ${JSON.stringify(initiative.workspace.rootPath)} was moved or deleted; restore the original directory or create a new Project`,
      );
    }
    for (const [index, binding] of bindings.entries()) {
      const checked = inspection.repositories[index];
      if (
        binding.path === null ||
        checked?.kind !== "directory" ||
        checked.canonicalPath !== binding.path
      ) {
        throw new Error(
          `saved checkout for project ${binding.projectId} at ${JSON.stringify(binding.path)} was moved or deleted`,
        );
      }
      if (inspection.rootContainsRepositories[index] !== true) {
        throw new Error(
          `saved checkout for project ${binding.projectId} is outside the shared workspace root`,
        );
      }
    }
  };

  const publishInitiative = (initiativeId: string | null): void => {
    publish(INITIATIVES_CHANNEL, { initiativeId });
  };

  const environmentResolutionTimeoutMs =
    environmentResolution?.timeoutMs ?? ENVIRONMENT_RESOLUTION_TIMEOUT_MS;
  const environmentResolutionPollMs =
    environmentResolution?.pollIntervalMs ?? ENVIRONMENT_RESOLUTION_POLL_MS;
  const environmentResolutionNow = environmentResolution?.now ?? Date.now;
  const waitForEnvironment =
    environmentResolution?.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));

  /**
   * BB assigns a host/unmanaged environment only after message.dispatch
   * admits the pending thread. The null id is therefore a durable transient:
   * this resolver works both during create and after a plugin reload.
   */
  const resolveSharedEnvironment = async (initiative: Initiative): Promise<Initiative> => {
    if (initiative.workspace.mode !== "shared-directory") return initiative;
    if (initiative.primaryEnvironmentId !== null) return initiative;
    const deadline = environmentResolutionNow() + environmentResolutionTimeoutMs;
    while (true) {
      const coordinator = await threads
        .get({ threadId: initiative.coordinatorThreadId })
        .catch(() => null);
      // Public thread reads can fail transiently while provisioning starts.
      // Retry those within the same deadline; an observed deleted row is
      // definitive and can fail immediately.
      if (coordinator !== null && coordinator.deletedAt !== null) {
        throw new Error(`coordinator thread for initiative ${initiative.id} is unavailable`);
      }
      // An environment may already be concrete when the provider later
      // fails. Persist it first: that provider error is not provisioning.
      if (coordinator !== null && coordinator.environmentId !== null) {
        const resolved = store.setPrimaryEnvironmentId(initiative.id, coordinator.environmentId);
        publishInitiative(initiative.id);
        return resolved;
      }
      if (coordinator?.status === "error") {
        throw new Error(
          `shared-directory coordinator environment provisioning failed for initiative ${initiative.id}`,
        );
      }
      const remainingMs = deadline - environmentResolutionNow();
      if (remainingMs <= 0) break;
      await waitForEnvironment(Math.min(environmentResolutionPollMs, remainingMs));
    }
    throw new Error(
      `shared-directory coordinator environment did not resolve within ${environmentResolutionTimeoutMs}ms`,
    );
  };

  /** One parent page at a time; a list failure propagates instead of faking an empty roster. */
  const listChildren = async (
    parentThreadId: string,
    archived: boolean,
  ): Promise<{ rows: Awaited<ReturnType<Threads["list"]>>; exhausted: boolean }> => {
    const collected: Awaited<ReturnType<Threads["list"]>> = [];
    for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
      const rows = await threads.list({
        parentThreadId,
        includeHidden: true,
        archived,
        limit: LIST_PAGE_SIZE,
        offset: page * LIST_PAGE_SIZE,
      });
      collected.push(...rows);
      if (rows.length < LIST_PAGE_SIZE) return { rows: collected, exhausted: false };
    }
    // A final full page means there may be more rows we never saw.
    return { rows: collected, exhausted: true };
  };

  const collectDescendants = async (
    rootThreadId: string,
    archived: boolean,
  ): Promise<{ threads: Awaited<ReturnType<Threads["list"]>>; truncated: boolean }> => {
    const collected: Awaited<ReturnType<Threads["list"]>> = [];
    let truncated = false;
    const seen = new Set<string>([rootThreadId]);
    const queue = [rootThreadId];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const { rows: children } = await listChildren(parent, archived);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        if (collected.length >= AGENT_LIMIT) {
          truncated = true;
          continue;
        }
        seen.add(child.id);
        collected.push(child);
        queue.push(child.id);
      }
    }
    return { threads: collected, truncated };
  };

  /**
   * The lifecycle traversal: EVERY descendant across both archived states,
   * uncapped. A mixed tree — an archived child with live grandchildren —
   * still yields them all, and page-limit exhaustion throws a retryable
   * error instead of letting archive claim a partial tree.
   */
  const collectAllDescendants = async (
    rootThreadId: string,
  ): Promise<Awaited<ReturnType<Threads["list"]>>> => {
    const collected: Awaited<ReturnType<Threads["list"]>> = [];
    const seen = new Set<string>([rootThreadId]);
    const queue = [rootThreadId];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const archived of [false, true]) {
        const { rows, exhausted } = await listChildren(parent, archived);
        if (exhausted) {
          throw new Error(
            `descendant listing under ${parent} exceeded ${LIST_PAGE_LIMIT * LIST_PAGE_SIZE} rows — archive/restore incomplete, retry`,
          );
        }
        for (const child of rows) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          collected.push(child);
          queue.push(child.id);
        }
      }
    }
    return collected;
  };

  const service: InitiativeService = {
    previewInitiativeWorkspace,
    membership: {
      roleHint(threadId, parentThreadId) {
        if (coordinatorIds.has(threadId)) return "coordinator";
        // The thread's own entry first: a cold-reload grandchild can be
        // indexed while its parent is still uncached.
        if (descendantIndex.has(threadId)) return "agent";
        if (
          parentThreadId !== null &&
          (coordinatorIds.has(parentThreadId) || descendantIndex.has(parentThreadId))
        ) {
          return "agent";
        }
        return null;
      },
      descendantInitiative(threadId) {
        return descendantIndex.get(threadId) ?? null;
      },
    },

    async createInitiative(input) {
      const requestedWorkspace = input.workspace ?? { mode: "legacy" as const };
      const primaryProjectId = input.workspaceProjectIds[0] ?? (await personalProjectId());
      let workspace: InitiativeWorkspace = requestedWorkspace;
      let workspaceBindings: InitiativeWorkspaceBinding[] = input.workspaceProjectIds.map(
        (projectId) => ({
          projectId,
          hostId: null,
          path: null,
        }),
      );
      let coordinatorEnvironment: SpawnEnvironment = environmentSpec(
        input.environmentId,
        input.environmentProviderId,
      );
      if (requestedWorkspace.mode === "shared-directory") {
        if (
          hasEnvironmentOverride(input.environmentId) ||
          hasEnvironmentOverride(input.environmentProviderId)
        ) {
          throw new Error(
            "shared-directory projects own one common environment; environment overrides are not allowed",
          );
        }
        const preview = await previewInitiativeWorkspace({
          workspaceProjectIds: input.workspaceProjectIds,
          candidate: {
            hostId: requestedWorkspace.hostId,
            rootPath: requestedWorkspace.rootPath,
          },
        });
        if (!preview.eligible || preview.selection === null) {
          throw new Error(
            `shared directory is not eligible: ${preview.errors.map((entry) => entry.message).join(" ")}`,
          );
        }
        if (
          preview.selection.hostId !== requestedWorkspace.hostId ||
          preview.selection.rootPath !== requestedWorkspace.rootPath
        ) {
          throw new Error(
            "the shared directory changed since confirmation; refresh the preview and confirm its canonical machine and root before creating the Project",
          );
        }
        workspace = {
          mode: "shared-directory",
          hostId: preview.selection.hostId,
          rootPath: preview.selection.rootPath,
        };
        workspaceBindings = preview.repositories.map((repository) => {
          if (repository.hostId === null || repository.path === null) {
            throw new Error(`repository ${repository.projectId} has no validated checkout`);
          }
          return {
            projectId: repository.projectId,
            hostId: repository.hostId,
            path: repository.path,
          };
        });
        coordinatorEnvironment = {
          type: "host" as const,
          hostId: workspace.hostId,
          workspace: {
            type: "unmanaged" as const,
            path: workspace.rootPath,
          },
        };
      }
      const initiativeId = `init_${crypto.randomUUID()}`;
      const nonce = crypto.randomUUID();
      // Register the nonce BEFORE spawn: the message.dispatch gate can see the
      // marked first message while this call is still in flight.
      pendingInits.add(nonce);
      const explicitPrompt =
        input.initialPrompt !== undefined && input.initialPrompt.trim().length > 0;
      const firstTurn = explicitPrompt
        ? input.initialPrompt!
        : `You are starting as the coordinator of the project "${input.name}". Acknowledge that the project's delegation, context, and subscription tools are ready, then wait for the user's first instruction.`;
      let thread: Awaited<ReturnType<Threads["spawn"]>> | null = null;
      let initiative: Initiative | null = null;
      try {
        // The marked first message is held queued at the dispatch gate until
        // the registry row below commits; its re-pass then starts a session
        // whose tools and instructions already resolve this initiative.
        thread = await threads.spawn({
          projectId: primaryProjectId,
          title: input.name,
          visibility: "visible",
          environment: coordinatorEnvironment,
          input: markedInput(firstTurn, nonce, !explicitPrompt),
          pluginMetadata: { initiativeId, focusProjectId: primaryProjectId },
          providerId: input.providerId ?? undefined,
          model: input.model ?? undefined,
          reasoningLevel: (input.reasoningLevel ?? undefined) as
            | PluginProviderReasoningLevel
            | undefined,
        });
        initiative = store.create({
          id: initiativeId,
          name: input.name,
          icon: input.icon ?? "",
          description: input.description ?? "",
          coordinatorThreadId: thread.id,
          workspace,
          workspaceBindings,
          primaryEnvironmentId:
            workspace.mode === "shared-directory"
              ? thread.environmentId
              : (input.environmentId ?? null),
          providerId: input.providerId ?? null,
          model: input.model ?? null,
          reasoningLevel: input.reasoningLevel ?? null,
        });
        coordinatorIds.add(thread.id);
        // Registry, workspace bindings, tools, and synchronous role hints are
        // durable before the held first message is admitted. Provisioning can
        // only attach the environment after this recheck.
        pendingInits.delete(nonce);
        publishInitiative(initiative.id);
        await recheckDispatch();
        if (workspace.mode === "shared-directory") {
          initiative = await resolveSharedEnvironment(initiative);
        }
      } catch (error) {
        pendingInits.delete(nonce);
        if (initiative !== null) {
          store.remove(initiative.id);
          coordinatorIds.delete(initiative.coordinatorThreadId);
          publishInitiative(null);
        }
        // Creation did not complete; delete its coordinator so the held first
        // message dies with it instead of surfacing as a ghost row. If delete
        // fails, the marker's fail-closed reject path covers it.
        if (thread !== null) {
          const orphanId = thread.id;
          await threads
            .delete({ threadId: orphanId, childThreadsConfirmed: true })
            .catch((cleanupError: unknown) => {
              log.warn(
                `orphaned coordinator thread ${orphanId} after failed initiative create: ${String(cleanupError)}`,
              );
            });
        }
        throw error;
      }
      return { initiative, threadId: thread.id };
    },

    updateInitiative(initiativeId, patch) {
      const initiative = store.update(initiativeId, patch);
      publishInitiative(initiative.id);
      return initiative;
    },

    writeContextDoc(input) {
      const result = store.writeDoc(input);
      if (result.outcome === "written") {
        publish(INITIATIVES_CHANNEL, {
          initiativeId: input.initiativeId,
          path: normalizeContextPath(input.path),
        });
      }
      return result;
    },

    deleteContextDoc(initiativeId, path) {
      const normalized = normalizeContextPath(path);
      const deletedCount = store.deleteDoc(initiativeId, normalized);
      if (deletedCount > 0) {
        publish(INITIATIVES_CHANNEL, { initiativeId, path: normalized });
      }
      return deletedCount;
    },

    async setArchived(initiativeId, archived) {
      const initiative = requireInitiative(initiativeId);
      if (archived) {
        // Pause FIRST, before any awaitable traversal can fail: the
        // subscription engine stops immediately, and a traversal or archive
        // failure below leaves the initiative paused and retryable.
        const updated = store.setArchived(initiativeId, true);
        publishInitiative(initiativeId);
        // Traverse both archived states so a live grandchild behind an
        // archived parent is never lost, and mutate only the threads whose
        // state still needs to change — a retry then converges over exactly
        // the remainder.
        const descendants = await collectAllDescendants(initiative.coordinatorThreadId);
        const coordinator = await threads
          .get({ threadId: initiative.coordinatorThreadId })
          .catch(() => null);
        const targets = descendants
          .filter((thread) => thread.archivedAt === null)
          .map((thread) => thread.id);
        if (
          coordinator !== null &&
          coordinator.deletedAt === null &&
          coordinator.archivedAt === null
        ) {
          targets.unshift(initiative.coordinatorThreadId);
        }
        const failed: string[] = [];
        lifecycleSync.add(initiativeId);
        try {
          for (const threadId of targets) {
            await threads.archive({ threadId }).catch((error: unknown) => {
              log.warn(`archive of initiative thread ${threadId} failed: ${String(error)}`);
              failed.push(threadId);
            });
          }
        } finally {
          lifecycleSync.delete(initiativeId);
        }
        if (failed.length > 0) {
          throw new Error(
            `archive incomplete: ${failed.length} of ${targets.length} threads failed — the project stays paused; retry to archive the rest`,
          );
        }
        return updated;
      }
      const coordinator = await threads
        .get({ threadId: initiative.coordinatorThreadId })
        .catch(() => null);
      // A deleted coordinator cannot come back; restore fails closed rather
      // than resurrecting a half-crew of descendants under a ghost.
      if (coordinator === null || coordinator.deletedAt !== null) {
        throw new Error(
          `coordinator thread for initiative ${initiativeId} is unavailable — the project stays archived`,
        );
      }
      const descendants = await collectAllDescendants(initiative.coordinatorThreadId);
      const targets = descendants
        .filter((thread) => thread.archivedAt !== null)
        .map((thread) => thread.id);
      if (coordinator.archivedAt !== null) {
        targets.unshift(initiative.coordinatorThreadId);
      }
      const failed: string[] = [];
      lifecycleSync.add(initiativeId);
      try {
        for (const threadId of targets) {
          await threads.unarchive({ threadId }).catch((error: unknown) => {
            log.warn(`unarchive of initiative thread ${threadId} failed: ${String(error)}`);
            failed.push(threadId);
          });
        }
      } finally {
        lifecycleSync.delete(initiativeId);
      }
      if (failed.length > 0) {
        // Registry flag NOT flipped: subscriptions stay paused and a retry
        // re-collects only the still-archived descendants.
        throw new Error(
          `restore incomplete: ${failed.length} of ${targets.length} threads failed — the project stays archived; retry to restore the rest`,
        );
      }
      const updated = store.setArchived(initiativeId, false);
      publishInitiative(initiativeId);
      return updated;
    },

    deleteInitiative(initiativeId) {
      const initiative = store.get(initiativeId);
      if (initiative === null) return;
      store.remove(initiativeId);
      coordinatorIds.delete(initiative.coordinatorThreadId);
      for (const [threadId, owner] of descendantIndex) {
        if (owner === initiativeId) descendantIndex.delete(threadId);
      }
      publishInitiative(null);
    },

    async spawnAgent(input) {
      let initiative = requireInitiative(input.initiativeId);
      requireActive(initiative);
      const projectId =
        input.projectId ?? initiative.workspaceProjectIds[0] ?? (await personalProjectId());
      if (
        initiative.workspaceProjectIds.length > 0 &&
        !initiative.workspaceProjectIds.includes(projectId)
      ) {
        throw new Error(`project ${projectId} is not bound to initiative ${initiative.id}`);
      }
      if (
        initiative.workspace.mode === "shared-directory" &&
        (hasEnvironmentOverride(input.environmentId) ||
          hasEnvironmentOverride(input.environmentProviderId))
      ) {
        throw new Error(
          "shared-directory agents must reuse the project's common environment; overrides are not allowed",
        );
      }
      await validatePersistedSharedWorkspace(initiative);
      if (
        initiative.workspace.mode === "shared-directory" &&
        initiative.primaryEnvironmentId === null
      ) {
        // Reload recovery is lazy and non-destructive: a transient native read
        // or timeout leaves the visible Project and its docs ready to retry.
        initiative = await resolveSharedEnvironment(initiative);
      }
      // A deleted or archived coordinator must surface as unavailable, never
      // silently respawn — the child would lose its parent linkage and its
      // reports. deletedAt comes back on the row, not only as a thrown error.
      const coordinator = await threads
        .get({ threadId: initiative.coordinatorThreadId })
        .catch(() => null);
      if (coordinator === null || coordinator.deletedAt !== null) {
        throw new Error(`coordinator thread for initiative ${initiative.id} is unavailable`);
      }
      if (coordinator.archivedAt !== null) {
        throw new Error(`coordinator thread for initiative ${initiative.id} is archived`);
      }
      // Same protocol as the coordinator: the marked first message is held at
      // the dispatch gate until membership is indexed below — the session it
      // starts resolves this child as an agent from turn one.
      const nonce = crypto.randomUUID();
      pendingInits.add(nonce);
      let child: Awaited<ReturnType<Threads["spawn"]>> | null = null;
      try {
        child = await threads.spawn({
          projectId:
            initiative.workspace.mode === "shared-directory"
              ? initiative.workspaceProjectIds[0]!
              : projectId,
          parentThreadId: initiative.coordinatorThreadId,
          title: input.title,
          visibility: "visible",
          environment:
            initiative.workspace.mode === "shared-directory"
              ? {
                  type: "reuse" as const,
                  environmentId: initiative.primaryEnvironmentId!,
                }
              : environmentSpec(input.environmentId, input.environmentProviderId),
          input: markedInput(input.prompt, nonce, false),
          pluginMetadata: { initiativeId: initiative.id, focusProjectId: projectId },
          providerId: input.providerId ?? initiative.providerId ?? undefined,
          model: input.model ?? initiative.model ?? undefined,
          reasoningLevel: (input.reasoningLevel ?? initiative.reasoningLevel ?? undefined) as
            | PluginProviderReasoningLevel
            | undefined,
        });
        descendantIndex.set(child.id, initiative.id);
      } catch (error) {
        pendingInits.delete(nonce);
        if (child !== null) {
          const orphanId = child.id;
          descendantIndex.delete(orphanId);
          await threads
            .delete({ threadId: orphanId, childThreadsConfirmed: true })
            .catch((cleanupError: unknown) => {
              log.warn(
                `orphaned agent thread ${orphanId} after failed dispatch: ${String(cleanupError)}`,
              );
            });
        }
        throw error;
      }
      pendingInits.delete(nonce);
      publishInitiative(initiative.id);
      await recheckDispatch();
      return { threadId: child.id };
    },

    async attachThread(initiativeId, threadId) {
      const initiative = requireInitiative(initiativeId);
      requireActive(initiative);
      if (initiative.workspace.mode === "shared-directory") {
        throw new Error(
          "attaching existing threads is not supported for shared-directory projects",
        );
      }
      if (threadId === initiative.coordinatorThreadId) {
        throw new Error("cannot attach a coordinator to itself");
      }
      // Another initiative's coordinator brings a whole second membership
      // claim — two project rails would own the same descendants.
      if (coordinatorIds.has(threadId)) {
        throw new Error(`thread ${threadId} coordinates another initiative`);
      }
      // So does another initiative's descendant: reparenting it would split
      // its subtree across two registries.
      const claimed = await service.resolveThread(threadId);
      if (claimed !== null) {
        throw new Error(
          `thread ${threadId} already belongs to initiative ${claimed.initiative.id}`,
        );
      }
      await threads.get({ threadId }).catch(() => {
        throw new Error(`thread ${threadId} not found`);
      });
      // Reparenting an ancestor of the coordinator under it would cycle the
      // ancestry and break every descendant walk.
      let cursor: string | null = initiative.coordinatorThreadId;
      for (let hop = 0; cursor !== null && hop < ANCESTOR_LIMIT; hop++) {
        if (cursor === threadId) {
          throw new Error(`thread ${threadId} is an ancestor of the coordinator`);
        }
        const ancestor: Awaited<ReturnType<Threads["get"]>> | null = await threads
          .get({ threadId: cursor })
          .catch(() => null);
        cursor = ancestor?.parentThreadId ?? null;
      }
      await threads.update({ threadId, parentThreadId: initiative.coordinatorThreadId });
      // The attached subtree joins wholesale — rebuild so every descendant
      // of threadId is indexed under this initiative, not just the root.
      await service.listAgents(initiative);
      publishInitiative(initiativeId);
    },

    async detachThread(initiativeId, threadId) {
      const initiative = requireInitiative(initiativeId);
      const resolved = await service.resolveThread(threadId);
      if (resolved === null || resolved.initiative.id !== initiative.id) {
        throw new Error(`thread ${threadId} is not a member of initiative ${initiativeId}`);
      }
      if (resolved.role === "coordinator") {
        throw new Error("cannot detach a coordinator from its own initiative");
      }
      await threads.update({ threadId, parentThreadId: null });
      // Rebuild prunes the whole detached subtree from the index.
      await service.listAgents(initiative);
      publishInitiative(initiativeId);
    },

    async resolveThread(threadId) {
      const seen = new Set<string>();
      let cursor: string | null = threadId;
      for (let hop = 0; cursor !== null && hop < ANCESTOR_LIMIT; hop++) {
        if (seen.has(cursor)) return null;
        seen.add(cursor);
        const initiative = store.getByCoordinator(cursor);
        if (initiative !== null) {
          return { initiative, role: cursor === threadId ? "coordinator" : "agent" };
        }
        const thread: Awaited<ReturnType<Threads["get"]>> | null = await threads
          .get({ threadId: cursor })
          .catch(() => null);
        if (thread === null) return null;
        cursor = thread.parentThreadId;
      }
      return null;
    },

    async dispatchGate(ctx) {
      // The marker protocol belongs to this plugin's own dispatches; a user
      // or another plugin's message that happens to carry the prefix is an
      // ordinary message, never gated or rejected.
      const nonce = ctx.originPluginId === pluginId ? markerNonce(ctx.inputBlocks) : null;
      if (nonce !== null) {
        // A marked first message may only start a session once membership is
        // durably resolvable. Three answers: proceed (registry/ancestry
        // resolves), wait (its init is in flight), reject (the marker outlived
        // its init — a failed create or a reload orphan; never release an
        // unconfigured session).
        const resolved = await service.resolveThread(ctx.threadId);
        if (resolved !== null) {
          // A resolved marked child still needs its index entry — the
          // synchronous roleHint/instructions path reads the index, not
          // ancestry, when the session is constructed after release.
          if (resolved.role === "agent") {
            descendantIndex.set(ctx.threadId, resolved.initiative.id);
          }
          return { action: "proceed" };
        }
        if (pendingInits.has(nonce)) {
          return { action: "wait", reason: "initiative membership is initializing" };
        }
        return {
          action: "reject",
          message: `initiative initialization ${nonce} never completed; this thread cannot start an unconfigured session`,
        };
      }
      // Every admission of a plausible member re-derives membership from
      // durable ancestry: the index can hold a stale claim after a native
      // reparent — to root, into another initiative, or under an uncached
      // parent — so the entry is refreshed or cleared, never trusted.
      if (ctx.parentThreadId !== null || descendantIndex.has(ctx.threadId)) {
        const resolved = await service.resolveThread(ctx.threadId);
        if (resolved?.role === "agent") {
          descendantIndex.set(ctx.threadId, resolved.initiative.id);
        } else {
          descendantIndex.delete(ctx.threadId);
        }
      }
      return { action: "proceed" };
    },

    async listAgents(initiative) {
      const { threads: descendants, truncated } = await collectDescendants(
        initiative.coordinatorThreadId,
        false,
      );
      const depthById = new Map<string, number>();
      const depthQueue: { threadId: string; depth: number }[] = [
        { threadId: initiative.coordinatorThreadId, depth: 0 },
      ];
      const byId = new Map(descendants.map((thread) => [thread.id, thread]));
      while (depthQueue.length > 0) {
        const { threadId, depth } = depthQueue.shift()!;
        for (const child of descendants) {
          if (child.parentThreadId !== threadId || depthById.has(child.id)) continue;
          depthById.set(child.id, depth + 1);
          depthQueue.push({ threadId: child.id, depth: depth + 1 });
        }
      }
      const agents: InitiativeAgent[] = descendants.map((thread) => ({
        threadId: thread.id,
        initiativeId: initiative.id,
        title: thread.title,
        status: thread.status,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        depth: depthById.get(thread.id) ?? 1,
        createdAt: thread.createdAt,
      }));
      for (const [id] of byId) descendantIndex.set(id, initiative.id);
      // Detached/deleted descendants drop out of the index with the rebuild —
      // but only a complete roster may prune: a truncated UI projection must
      // not erase membership the admission gate just established.
      if (!truncated) {
        for (const [threadId, owner] of descendantIndex) {
          if (owner === initiative.id && !byId.has(threadId)) descendantIndex.delete(threadId);
        }
      }
      return { agents, truncated };
    },

    async coordinatorSnapshot(initiative) {
      const thread = await threads
        .get({ threadId: initiative.coordinatorThreadId })
        .catch(() => null);
      if (thread === null || thread.deletedAt !== null) {
        return { status: null, available: false };
      }
      return { status: thread.status, available: true };
    },

    noteNativeThreadState(threadId, state) {
      const initiative = store.getByCoordinator(threadId);
      // Not a coordinator, or our own archive loop emitted this event.
      if (initiative === null || lifecycleSync.has(initiative.id)) return;
      if (state === "deleted") {
        // The row stays; every read path already reports the coordinator
        // unavailable from deletedAt. Publish so open UIs redraw it.
        publishInitiative(initiative.id);
        return;
      }
      const archived = state === "archived";
      if ((initiative.archivedAt !== null) === archived) return;
      store.setArchived(initiative.id, archived);
      publishInitiative(initiative.id);
    },

    noteThreadCreated(thread) {
      if (thread.parentThreadId === null) return;
      const owner =
        store.getByCoordinator(thread.parentThreadId)?.id ??
        descendantIndex.get(thread.parentThreadId);
      if (owner !== undefined) descendantIndex.set(thread.id, owner);
    },
  };

  return service;
}
