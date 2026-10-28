// Reads the reply's own thread's state from BB for Changes, Commits,
// PullRequest and Threads, through the SDK only (never git). Every call acts
// for one thread id: Changes, Commits and PullRequest read that thread's
// environment; Threads lists only threads of that thread's project, and any
// other id is "not found". Environments has its own source (environments.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  matchesPathFilter,
  RUNNING,
  MAX_COMMITS,
  THREAD_ID,
  type ChangedFile,
  type ChangeKind,
  type ChangesResult,
  type ChangesScope,
  type ChangesTarget,
  type ChangesView,
  type CommitsResult,
  type CommitsView,
  type FilePatch,
  type PatchesResult,
  type ProjectFailure,
  type ProjectRequest,
  type ProjectResult,
  type PullRequestInfo,
  type PullRequestResult,
  type ThreadDisplayStatus,
  type ThreadInfo,
  type ThreadsResult,
} from "../core/project";
import { lastMessage, pendingAsk, workersByParent, type LastMessage } from "../core/thread-activity";
import type { EnvironmentsSource } from "./environments";
import { createSnapshots, fitChanges, PATCH_BYTES, SNAPSHOT_BYTES, snapshotKey, type SnapshotStorage } from "./snapshots";

/** Keep what is shown in this reply block (`blockKey`), or replace what was kept (`refresh`). */
export interface Keep {
  readonly blockKey: string;
  readonly refresh: boolean;
}

export interface ProjectSource {
  changes(threadId: string, target: ChangesTarget, paths: readonly string[] | null, keep: Keep | null): Promise<ChangesResult>;
  /** Patches of changed files Changes didn't get inline. */
  patches(threadId: string, target: ChangesTarget, paths: readonly string[]): Promise<PatchesResult>;
  commits(threadId: string, keep: Keep | null): Promise<CommitsResult>;
  pullRequest(threadId: string): Promise<PullRequestResult>;
  threads(threadId: string, ids: readonly string[] | null): Promise<ThreadsResult>;
}

/** Answers the markdown fallback's reads for one thread, live (markdown renderings keep nothing). */
export function projectReader(
  source: ProjectSource,
  environments: EnvironmentsSource,
  threadId: string,
): (request: ProjectRequest) => Promise<ProjectResult> {
  return (request) => {
    switch (request.kind) {
      case "changes":
        return source.changes(threadId, request.target, request.paths, null);
      case "commits":
        return source.commits(threadId, null);
      case "pullRequest":
        return source.pullRequest(threadId);
      case "threads":
        return source.threads(threadId, request.ids);
      case "environments":
        return environments.environments(threadId, true);
    }
  };
}

/** Most subthreads a Threads list reads. */
export const MAX_SUBTHREADS = 200;

/** Patches requested per diffPatch call while filling a snapshot. */
const PATCH_BATCH = 25;

/** Most on-demand patches a snapshot asks BB for. */
const MAX_SNAPSHOT_PATCH_FILES = 200;

/** How long provider names and thread models are reused before asking BB again. */
const CACHE_MS = 60_000;

/** Most threads whose latest message is kept between reads. */
const MESSAGE_CACHE = 500;

type Sdk = BbPluginApi["sdk"];

function failure(reason: ProjectFailure["reason"], message: string): ProjectFailure {
  return { ok: false, reason, message };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** BB's answer for a checkout it couldn't read, as a failure. */
interface UnavailableOutcome {
  readonly outcome: "not_applicable" | "unavailable";
  readonly message?: string;
  readonly failure?: { readonly code: string; readonly message: string };
}

export function outcomeFailure(answer: UnavailableOutcome): ProjectFailure {
  if (answer.outcome === "not_applicable") return failure("not-git", "This thread's environment isn't a git checkout");
  const code = answer.failure?.code;
  if (code === "not_git_repo" || code === "workspace_type_mismatch") {
    return failure("not-git", "This thread's environment isn't a git checkout");
  }
  return failure("unavailable", answer.failure?.message ?? answer.message ?? "BB couldn't read the checkout");
}

/** A path for diffPatch: repository-relative, never absolute or climbing out. */
export function isRepositoryPath(path: string): boolean {
  return path !== "" && path.length <= 1024 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0");
}

interface DiffFileEntry {
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeKind: ChangeKind;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly loadMode: "auto" | "on_demand" | "too_large";
  readonly origin: "tracked" | "untracked";
}

/** BB's diffFiles entry as Changes shows it. */
export function changedFile(file: DiffFileEntry, inline: boolean): ChangedFile {
  return {
    path: file.path,
    previousPath: file.previousPath,
    kind: file.changeKind,
    additions: file.additions,
    deletions: file.deletions,
    untracked: file.origin === "untracked",
    diff: file.binary ? "binary" : file.loadMode === "too_large" ? "too-large" : inline ? "inline" : "on-demand",
  };
}

interface PullRequestEntry {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PullRequestInfo["state"];
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly checks: {
    readonly state: PullRequestInfo["checks"]["state"];
    readonly passedCount: number;
    readonly failedCount: number;
    readonly pendingCount: number;
    readonly totalCount: number;
  };
  readonly review: { readonly state: PullRequestInfo["review"]["state"]; readonly reviewRequestCount: number };
  readonly mergeability: { readonly state: PullRequestInfo["mergeability"] };
  readonly attention: PullRequestInfo["attention"];
  readonly autoMerge: boolean;
  readonly inMergeQueue: boolean | null;
  readonly updatedAt: string;
}

export function pullRequestInfo(pr: PullRequestEntry): PullRequestInfo {
  const updatedAt = Date.parse(pr.updatedAt);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    checks: {
      state: pr.checks.state,
      passed: pr.checks.passedCount,
      failed: pr.checks.failedCount,
      pending: pr.checks.pendingCount,
      total: pr.checks.totalCount,
    },
    review: { state: pr.review.state, requests: pr.review.reviewRequestCount },
    mergeability: pr.mergeability.state,
    attention: pr.attention,
    autoMerge: pr.autoMerge,
    inMergeQueue: pr.inMergeQueue === true,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

/** The thread and its environment, or why there is none. */
async function threadEnvironment(
  sdk: Sdk,
  threadId: string,
): Promise<{ readonly ok: true; readonly environmentId: string } | ProjectFailure> {
  if (!THREAD_ID.test(threadId)) return failure("invalid", `"${threadId}" is not a thread id`);
  let thread;
  try {
    thread = await sdk.threads.get({ threadId });
  } catch {
    return failure("not-found", "BB has no such thread");
  }
  if (thread.deletedAt !== null) return failure("not-found", "This thread was deleted");
  if (thread.environmentId === null) return failure("no-environment", "This thread has no environment");
  return { ok: true, environmentId: thread.environmentId };
}

/** The checkout's status measured against its merge-base branch (the environment's own, else the default branch). */
async function workspaceStatus(sdk: Sdk, environmentId: string) {
  const environment = await sdk.environments.get({ environmentId });
  if (!environment.isGitRepo) return failure("not-git", "This thread's environment isn't a git checkout");
  let base = environment.mergeBaseBranch ?? environment.defaultBranch;
  let status = await sdk.environments.status({ environmentId, ...(base === null ? {} : { mergeBaseBranch: base }) });
  if (status.outcome !== "available") return outcomeFailure(status);
  if (base === null) {
    base = status.workspace.branch.defaultBranch;
    status = await sdk.environments.status({ environmentId, mergeBaseBranch: base });
    if (status.outcome !== "available") return outcomeFailure(status);
  }
  return { ok: true as const, base, workspace: status.workspace };
}

/** What BB says is checked out (environments.status `workspace.checkout`). */
type Checkout =
  | { readonly kind: "branch"; readonly branchName: string; readonly headSha: string | null }
  | { readonly kind: "detached"; readonly headSha: string | null }
  | { readonly kind: "unborn"; readonly branchName: string | null }
  | { readonly kind: "unknown"; readonly reason: string };

type DiffQuery =
  | { readonly target: "uncommitted" }
  | { readonly target: "all"; readonly mergeBaseBranch: string }
  | { readonly target: "commit"; readonly sha: string };

/** What BB is asked for, and how the header names it. */
export function diffQuery(
  target: ChangesTarget,
  checkout: Checkout,
  base: string,
  commits: readonly { readonly sha: string; readonly subject: string }[],
): { query: DiffQuery; scope: ChangesScope } | ProjectFailure {
  if (target.kind === "commit") {
    const commit = commits.find((candidate) => candidate.sha.startsWith(target.sha)) ?? null;
    return { query: { target: "commit", sha: target.sha }, scope: { kind: "commit", sha: commit?.sha ?? target.sha, subject: commit?.subject ?? null } };
  }
  if (checkout.kind === "unknown") return failure("unavailable", `BB can't tell what is checked out: ${checkout.reason}`);
  const branch = checkout.kind === "detached" ? null : checkout.branchName;
  if (target.kind === "uncommitted" || checkout.kind === "unborn") {
    return { query: { target: "uncommitted" }, scope: { kind: "uncommitted", branch, unborn: checkout.kind === "unborn" } };
  }
  const head = checkout.kind === "detached" && checkout.headSha !== null ? checkout.headSha.slice(0, 7) : null;
  // On the base branch itself the branch's work is its uncommitted work.
  const onBase = branch === base;
  return {
    query: onBase ? { target: "uncommitted" } : { target: "all", mergeBaseBranch: base },
    scope: { kind: "branch", branch, head, base, onBase },
  };
}

function patchTarget(query: DiffQuery) {
  switch (query.target) {
    case "uncommitted":
      return { type: "uncommitted" as const };
    case "all":
      return { type: "all" as const, mergeBaseBranch: query.mergeBaseBranch };
    case "commit":
      return { type: "commit" as const, sha: query.sha };
  }
}

export function createProjectSource(bb: BbPluginApi, storage: SnapshotStorage = bb.storage.kv): ProjectSource {
  const sdk = bb.sdk;
  const snapshots = createSnapshots(storage);

  /** The diff query for a thread's target, with the environment it runs in. */
  async function resolveDiff(threadId: string, target: ChangesTarget) {
    const environment = await threadEnvironment(sdk, threadId);
    if (!environment.ok) return environment;
    const status = await workspaceStatus(sdk, environment.environmentId);
    if (!status.ok) return status;
    const { workspace, base } = status;
    const resolved = diffQuery(target, workspace.checkout, base, workspace.mergeBase?.commits ?? []);
    if ("ok" in resolved) return resolved;
    return { ok: true as const, environmentId: environment.environmentId, ...resolved };
  }

  /** On-demand patches for a snapshot, in file order, until they'd no longer fit. */
  async function snapshotPatches(environmentId: string, query: DiffQuery, files: readonly ChangedFile[]): Promise<FilePatch[]> {
    const wanted = files
      .filter((file) => file.diff === "on-demand" && isRepositoryPath(file.path))
      .slice(0, MAX_SNAPSHOT_PATCH_FILES)
      .map((file) => file.path);
    const found: FilePatch[] = [];
    let bytes = 0;
    for (let start = 0; start < wanted.length && bytes < SNAPSHOT_BYTES; start += PATCH_BATCH) {
      const answer = await sdk.environments.diffPatch({
        environmentId,
        paths: wanted.slice(start, start + PATCH_BATCH),
        target: patchTarget(query),
      });
      if (answer.outcome !== "available") break;
      for (const patch of answer.patches) {
        found.push(patch);
        if (patch.patch.length <= PATCH_BYTES) bytes += patch.patch.length;
      }
    }
    return found;
  }

  async function liveChanges(threadId: string, target: ChangesTarget, filter: readonly string[] | null, keep: boolean): Promise<ChangesResult> {
    const resolved = await resolveDiff(threadId, target);
    if (!resolved.ok) return resolved;
    const { environmentId, query, scope } = resolved;
    const answer = await sdk.environments.diffFiles({ environmentId, ...query });
    if (answer.outcome !== "available") return outcomeFailure(answer);
    const inline = new Set(answer.initialPatches.map((patch) => patch.path));
    const all = answer.files.map((file) => changedFile(file, inline.has(file.path)));
    const files = all.filter(
      (file) => matchesPathFilter(file.path, filter) || (file.previousPath !== null && matchesPathFilter(file.previousPath, filter)),
    );
    const shown = new Set(files.map((file) => file.path));
    const patches = answer.initialPatches.filter((patch) => shown.has(patch.path));
    const view: ChangesView = {
      ok: true,
      scope,
      files,
      totalFiles: all.length,
      filter,
      listTruncated: answer.truncated,
      patches,
      livePatches: true,
      takenAt: Date.now(),
      stored: false,
    };
    if (!keep) return view;
    return fitChanges(view, [...patches, ...(await snapshotPatches(environmentId, query, files))]);
  }

  async function liveCommits(threadId: string): Promise<CommitsResult> {
    const environment = await threadEnvironment(sdk, threadId);
    if (!environment.ok) return environment;
    const status = await workspaceStatus(sdk, environment.environmentId);
    if (!status.ok) return status;
    const { workspace, base } = status;
    const checkout = workspace.checkout;
    if (checkout.kind === "unknown") return failure("unavailable", `BB can't tell what is checked out: ${checkout.reason}`);
    const mergeBase = workspace.mergeBase;
    // BB lists the branch's commits oldest first (git log --reverse order); Commits shows them newest first.
    const commits = (mergeBase?.commits ?? [])
      .map((commit) => ({
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        author: commit.authorName,
        authoredAt: commit.authoredAt,
      }))
      .reverse();
    const branch = checkout.kind === "detached" ? null : checkout.branchName;
    return {
      ok: true,
      branch,
      checkout: checkout.kind,
      head: checkout.kind === "unborn" || checkout.headSha === null ? null : checkout.headSha.slice(0, 7),
      base,
      onBase: branch === base,
      ahead: mergeBase?.aheadCount ?? null,
      behind: mergeBase?.behindCount ?? null,
      commits: commits.slice(0, MAX_COMMITS),
      commitsTruncated: commits.length > MAX_COMMITS,
      takenAt: Date.now(),
      stored: false,
    };
  }

  let providers: { at: number; names: Map<string, { name: string; logoUrl: string | null }> } | null = null;
  async function providerNames() {
    if (providers === null || Date.now() - providers.at > CACHE_MS) {
      const list = await sdk.providers.list().catch(() => []);
      providers = { at: Date.now(), names: new Map(list.map((provider) => [provider.id, { name: provider.displayName, logoUrl: provider.logoUrl ?? null }])) };
    }
    return providers.names;
  }

  const models = new Map<string, { at: number; model: string | null; reasoning: string | null }>();
  async function threadModel(threadId: string): Promise<{ model: string | null; reasoning: string | null }> {
    const cached = models.get(threadId);
    if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached;
    const options = await sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
    const reasoning = options?.reasoningLevel;
    const entry = { at: Date.now(), model: options?.model || null, reasoning: reasoning === undefined || reasoning === "none" ? null : reasoning };
    models.set(threadId, entry);
    return entry;
  }

  /**
   * Each thread's latest assistant message, read again only once the thread
   * has done something since (`stamp`: its last activity). A failed read
   * keeps what was read before.
   */
  const messages = new Map<string, { stamp: number; message: LastMessage | null }>();
  async function latestMessage(threadId: string, stamp: number): Promise<LastMessage | null> {
    const cached = messages.get(threadId);
    if (cached !== undefined && cached.stamp === stamp) return cached.message;
    const answer = await sdk.threads.output({ threadId }).catch(() => null);
    if (answer === null) return cached?.message ?? null;
    const message = lastMessage(answer.output);
    messages.delete(threadId);
    messages.set(threadId, { stamp, message });
    // Oldest reads go first once the cache is full.
    if (messages.size > MESSAGE_CACHE) messages.delete(messages.keys().next().value as string);
    return message;
  }

  /**
   * How many threads BB runs under each parent (hidden workflow steps
   * included). One listRunning call; a running thread's parent is read once
   * and kept while it runs.
   */
  const runningParents = new Map<string, string | null>();
  async function runningWorkers(): Promise<Map<string, number>> {
    const running = await sdk.threads.listRunning().catch(() => []);
    const ids = new Set(running.map((thread) => thread.id));
    for (const id of runningParents.keys()) if (!ids.has(id)) runningParents.delete(id);
    const parents = await Promise.all(
      [...ids].map(async (id) => {
        const known = runningParents.get(id);
        if (known !== undefined) return known;
        const thread = await sdk.threads.get({ threadId: id }).catch(() => null);
        if (thread === null) return null;
        runningParents.set(id, thread.parentThreadId);
        return thread.parentThreadId;
      }),
    );
    return workersByParent(parents);
  }

  interface ThreadFields {
    readonly id: string;
    readonly title: string | null;
    readonly titleFallback: string | null;
    readonly runtime: { readonly displayStatus: ThreadDisplayStatus };
    readonly archivedAt: number | null;
    readonly providerId: string;
    readonly updatedAt: number;
    /** threads.list says it; threads.get doesn't, so a named thread's interactions are always read. */
    readonly hasPendingInteraction?: boolean;
  }

  /**
   * When the thread last did something. BB moves `updatedAt` on status
   * changes, so a thread running for an hour would read as an hour old: a
   * running thread's latest event says when it last acted.
   */
  async function lastActivity(thread: ThreadFields): Promise<number> {
    if (!RUNNING[thread.runtime.displayStatus]) return thread.updatedAt;
    const [latest] = await sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1" }).catch(() => []);
    return Math.max(thread.updatedAt, latest?.createdAt ?? 0);
  }

  async function threadInfo(thread: ThreadFields, workers: ReadonlyMap<string, number>): Promise<ThreadInfo> {
    const archived = thread.archivedAt !== null;
    const flagged = thread.hasPendingInteraction;
    const [providers, options, activity, pending] = await Promise.all([
      providerNames(),
      threadModel(thread.id),
      lastActivity(thread).then(async (at) => ({ at, message: await latestMessage(thread.id, at) })),
      // Undefined: BB couldn't list the interactions.
      flagged === true || (flagged === undefined && !archived)
        ? sdk.threads.interactions.list({ threadId: thread.id }).then(pendingAsk, () => undefined)
        : null,
    ]);
    const provider = providers.get(thread.providerId);
    return {
      found: true,
      id: thread.id,
      title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread",
      status: thread.runtime.displayStatus,
      // BB's flag where it gives one (an interaction it is still resolving counts); else whether one is pending.
      needsInput: flagged ?? (pending !== null && pending !== undefined),
      archived,
      provider: { id: thread.providerId, name: provider?.name ?? null, logoUrl: provider?.logoUrl ?? null },
      model: options.model,
      reasoning: options.reasoning,
      updatedAt: activity.at,
      lastMessage: activity.message,
      pending: pending ?? null,
      runningWorkers: workers.get(thread.id) ?? 0,
    };
  }

  return {
    async changes(threadId, target, paths, keep) {
      try {
        // A commit never changes: nothing to keep.
        if (keep === null || target.kind === "commit") return await liveChanges(threadId, target, paths, false);
        const request: ProjectRequest = { kind: "changes", target, paths };
        const key = snapshotKey(threadId, keep.blockKey, request);
        if (!keep.refresh) {
          const kept = await snapshots.readChanges(key, threadId);
          if (kept !== null) return kept;
        }
        const view = await liveChanges(threadId, target, paths, true);
        if (view.ok) await snapshots.writeChanges(key, threadId, view);
        return view;
      } catch (cause) {
        return failure("unavailable", `BB couldn't read the changes: ${errorMessage(cause)}`);
      }
    },

    async patches(threadId, target, paths) {
      if (paths.length === 0 || paths.length > PATCH_BATCH || !paths.every(isRepositoryPath)) {
        return failure("invalid", "Those aren't paths of changed files");
      }
      try {
        const resolved = await resolveDiff(threadId, target);
        if (!resolved.ok) return resolved;
        const answer = await sdk.environments.diffPatch({
          environmentId: resolved.environmentId,
          paths: [...paths],
          target: patchTarget(resolved.query),
        });
        if (answer.outcome !== "available") return outcomeFailure(answer);
        return { ok: true, patches: answer.patches };
      } catch (cause) {
        return failure("unavailable", `BB couldn't read the diff: ${errorMessage(cause)}`);
      }
    },

    async commits(threadId, keep) {
      try {
        if (keep === null) return await liveCommits(threadId);
        const key = snapshotKey(threadId, keep.blockKey, { kind: "commits" });
        if (!keep.refresh) {
          const kept = await snapshots.readCommits(key, threadId);
          if (kept !== null) return kept;
        }
        const view = await liveCommits(threadId);
        if (!view.ok) return view;
        const stored: CommitsView = { ...view, stored: true };
        await snapshots.writeCommits(key, threadId, stored);
        return stored;
      } catch (cause) {
        return failure("unavailable", `BB couldn't read the commits: ${errorMessage(cause)}`);
      }
    },

    async pullRequest(threadId) {
      try {
        const environment = await threadEnvironment(sdk, threadId);
        if (!environment.ok) return environment;
        const [answer, env] = await Promise.all([
          sdk.environments.pullRequest({ environmentId: environment.environmentId }),
          sdk.environments.get({ environmentId: environment.environmentId }),
        ]);
        if (answer.outcome === "unavailable") return failure("unavailable", answer.message);
        return {
          ok: true,
          branch: env.branchName,
          pullRequest: answer.outcome === "available" ? pullRequestInfo(answer.pullRequest) : null,
          fetchedAt: Date.now(),
        };
      } catch (cause) {
        return failure("unavailable", `BB couldn't read the pull request: ${errorMessage(cause)}`);
      }
    },

    async threads(threadId, ids) {
      if (!THREAD_ID.test(threadId)) return failure("invalid", `"${threadId}" is not a thread id`);
      try {
        let own;
        try {
          own = await sdk.threads.get({ threadId });
        } catch {
          return failure("not-found", "BB has no such thread");
        }
        if (ids === null) {
          const [listed, workers] = await Promise.all([
            sdk.threads.list({ parentThreadId: threadId, limit: MAX_SUBTHREADS + 1 }),
            runningWorkers(),
          ]);
          const children = listed.filter((thread) => thread.deletedAt === null && thread.projectId === own.projectId);
          return {
            ok: true,
            mode: "subthreads",
            threads: await Promise.all(children.slice(0, MAX_SUBTHREADS).map((thread) => threadInfo(thread, workers))),
            truncated: children.length > MAX_SUBTHREADS,
            fetchedAt: Date.now(),
          };
        }
        const workers = runningWorkers();
        const threads = await Promise.all(
          ids.map(async (id) => {
            const missing = { found: false as const, id };
            if (!THREAD_ID.test(id)) return missing;
            const thread = await sdk.threads.get({ threadId: id }).catch(() => null);
            // Another project's thread is as invisible here as an unknown one.
            if (thread === null || thread.deletedAt !== null || thread.projectId !== own.projectId) return missing;
            return threadInfo(thread, await workers);
          }),
        );
        return { ok: true, mode: "ids", threads, truncated: false, fetchedAt: Date.now() };
      } catch (cause) {
        return failure("unavailable", `BB couldn't read the threads: ${errorMessage(cause)}`);
      }
    },
  };
}
