// Reads the reply's own thread's state for Changes, Commits, PullRequest
// and Threads, through the SDK only (never git): the checkout through Source
// Control's reads (checkout.ts), everything else from BB. Every call acts
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
  pullRequestAttention,
  pullRequestRefKey,
  PULL_REQUESTS_SHOWN,
  type PullRequestInfo,
  type PullRequestRead,
  type PullRequestRef,
  type PullRequestResult,
  type PullRequestsResult,
  type ThreadDisplayStatus,
  type ThreadInfo,
  type ThreadsResult,
} from "../core/project";
import { lastMessage, pendingAsk, workersByParent, type LastMessage } from "../core/thread-activity";
import type { EnvironmentsSource } from "./environments";
import {
  checkoutFiles,
  checkoutPatches,
  checkoutStatus,
  PATCH_BATCH,
  pullRequest as readPullRequest,
  pullRequestsByRef,
  type PrStatus,
  type CheckoutFile,
  type CheckoutHead,
  type CheckoutProblem,
  type CheckoutTarget,
} from "./checkout";
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
  /** Pull requests by reference (at most PULL_REQUESTS_SHOWN), each answering for itself. */
  pullRequests(threadId: string, refs: readonly PullRequestRef[], refresh: boolean): Promise<PullRequestsResult>;
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
      case "pullRequests":
        return source.pullRequests(threadId, request.refs, false);
      case "threads":
        return source.threads(threadId, request.ids);
      case "environments":
        return environments.environments(threadId, true);
    }
  };
}

/** How long a pull request read by reference is reused: merged and closed ones don't change. */
function cacheAge(read: PullRequestRead): number {
  if (read.ok && (read.pullRequest.state === "merged" || read.pullRequest.state === "closed")) return 10 * 60_000;
  return 10_000;
}

/** Most pull requests kept from by-reference reads. */
const PULL_REQUEST_CACHE = 500;

/** Most subthreads a Threads list reads. */
export const MAX_SUBTHREADS = 200;

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

/** Why Source Control couldn't read the checkout, as a failure. */
export function problemFailure(problem: CheckoutProblem): ProjectFailure {
  switch (problem.kind) {
    case "host-offline":
      return failure("unavailable", `${problem.host ?? "The checkout's machine"} is offline`);
    case "moved":
      return failure("no-environment", problem.detail ?? "This thread has no checkout");
    case "tool-missing":
      return failure("unavailable", `git isn't installed on ${problem.host ?? "the checkout's machine"}`);
    default:
      return failure("unavailable", problem.detail ?? "Source Control couldn't read the checkout");
  }
}

/** A path for diffPatch: repository-relative, never absolute or climbing out. */
export function isRepositoryPath(path: string): boolean {
  return path !== "" && path.length <= 1024 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0");
}

/** Changed lines past which a file's diff isn't shown as text. */
export const TOO_LARGE_LINES = 20_000;

/** A `checkoutFiles` entry as Changes shows it. */
export function changedFile(file: CheckoutFile, inline: boolean): ChangedFile {
  return {
    path: file.path,
    previousPath: file.previousPath,
    kind: file.kind,
    additions: file.additions,
    deletions: file.deletions,
    untracked: file.untracked,
    diff: file.binary
      ? "binary"
      : inline
        ? "inline"
        : file.additions + file.deletions > TOO_LARGE_LINES
          ? "too-large"
          : "on-demand",
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

/**
 * A pull request Source Control read by reference, labelled as bb's GitHub
 * PR status plugin labels the branch's, so one pull request reads the same
 * through either source. Only GitHub merge states that name one label are
 * used (BEHIND and HAS_HOOKS say nothing on their own): anything else is
 * "unknown", which claims no "Blocked" or "Ready to merge".
 */
export function prStatusInfo(pr: PrStatus): PullRequestInfo {
  const state: PullRequestInfo["state"] = pr.state === "open" && pr.isDraft ? "draft" : pr.state;
  const total = pr.checks.passed + pr.checks.failed + pr.checks.pending;
  const checks: PullRequestInfo["checks"] = {
    state: total === 0 ? "no_checks" : pr.checks.failed > 0 ? "failing" : pr.checks.pending > 0 ? "pending" : "passing",
    passed: pr.checks.passed,
    failed: pr.checks.failed,
    pending: pr.checks.pending,
    total,
  };
  const requested = pr.reviewRequests > 0;
  const review: PullRequestInfo["review"] = {
    state:
      pr.reviewDecision === "APPROVED"
        ? "approved"
        : pr.reviewDecision === "CHANGES_REQUESTED"
          ? "changes_requested"
          : pr.reviewDecision === "REVIEW_REQUIRED"
            ? requested
              ? "review_requested"
              : "review_required"
            : requested
              ? "review_requested"
              : "none",
    requests: pr.reviewRequests,
  };
  const merge = pr.mergeStateStatus;
  const mergeability: PullRequestInfo["mergeability"] =
    pr.mergeable === "CONFLICTING" || merge === "DIRTY"
      ? "conflicts"
      : (pr.state === "open" && pr.isDraft) || merge === "DRAFT"
        ? "draft"
        : merge === "BLOCKED"
          ? "blocked"
          : merge === "CLEAN" || merge === "UNSTABLE"
            ? "mergeable"
            : "unknown";
  const updatedAt = pr.updatedAt === null ? Number.NaN : Date.parse(pr.updatedAt);
  const info = { state, checks, review, mergeability, inMergeQueue: pr.inMergeQueue };
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    ...info,
    attention: pullRequestAttention(info),
    autoMerge: pr.autoMerge,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

/**
 * Whether GitHub will change the pull request without anyone acting: checks
 * running, mergeability being computed (GitHub's UNKNOWN), or the merge
 * queue. A merge state that names no label (BEHIND, HAS_HOOKS) is settled:
 * it shows as "unknown" but reading again won't change it.
 */
export function prStatusSettling(pr: PrStatus): boolean {
  if (pr.state !== "open") return false;
  return pr.checks.pending > 0 || pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN" || pr.inMergeQueue;
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
  const answer = await checkoutStatus(sdk, environmentId, environment.mergeBaseBranch ?? environment.defaultBranch);
  if (!answer.ok) return problemFailure(answer.problem);
  const workspace = answer.value;
  if (workspace.state === "missing") return failure("unavailable", "This thread's workspace folder is gone");
  if (workspace.state === "not-git") return failure("not-git", "This thread's environment isn't a git checkout");
  if (workspace.base === null) return failure("unavailable", "This checkout has no default branch to compare with");
  return { ok: true as const, base: workspace.base, workspace };
}

/** The branch checked out, or null for a detached HEAD. */
export function branchOf(head: CheckoutHead): string | null {
  return head.kind === "detached" ? null : head.name;
}

/** What Source Control is asked for, and how the header names it. */
export function diffQuery(
  target: ChangesTarget,
  head: CheckoutHead,
  base: string,
  commits: readonly { readonly sha: string; readonly subject: string }[],
): { query: CheckoutTarget; scope: ChangesScope } {
  if (target.kind === "commit") {
    const commit = commits.find((candidate) => candidate.sha.startsWith(target.sha)) ?? null;
    return { query: { kind: "commit", sha: target.sha }, scope: { kind: "commit", sha: commit?.sha ?? target.sha, subject: commit?.subject ?? null } };
  }
  const branch = branchOf(head);
  if (target.kind === "uncommitted" || head.kind === "unborn") {
    return { query: { kind: "uncommitted" }, scope: { kind: "uncommitted", branch, unborn: head.kind === "unborn" } };
  }
  const short = head.kind === "detached" ? head.sha.slice(0, 7) : null;
  // On the base branch itself the branch's work is its uncommitted work.
  const onBase = branch === base;
  return {
    query: onBase ? { kind: "uncommitted" } : { kind: "branch", base },
    scope: { kind: "branch", branch, head: short, base, onBase },
  };
}

export function createProjectSource(bb: BbPluginApi, storage: SnapshotStorage = bb.storage.kv): ProjectSource {
  const sdk = bb.sdk;
  const snapshots = createSnapshots(storage);

  /** Pull requests read by reference, by environment and ref, with when they were read. */
  const pullRequestCache = new Map<string, { readonly at: number; readonly read: PullRequestRead }>();
  /** By-reference reads in flight, by environment and refs asked: blocks naming the same pull requests share one. */
  const pullRequestReads = new Map<string, Promise<ReadonlyMap<string, PullRequestRead>>>();

  /** Asks Source Control for `refs`; a Source Control that can't be asked leaves each one unavailable. */
  async function readPullRequestsByRef(
    environmentId: string | null,
    refs: readonly PullRequestRef[],
  ): Promise<ReadonlyMap<string, PullRequestRead>> {
    const reads = new Map<string, PullRequestRead>();
    try {
      const answer = await pullRequestsByRef(sdk, environmentId, refs);
      for (const ref of refs) {
        const key = pullRequestRefKey(ref);
        const read = answer[key];
        reads.set(
          key,
          read === undefined
            ? { ok: false, reason: "unavailable", message: `Source Control didn't answer for ${key}` }
            : read.ok
              ? { ok: true, pullRequest: prStatusInfo(read.value), settling: prStatusSettling(read.value) }
              : { ok: false, reason: read.reason, message: read.message },
        );
      }
    } catch (cause) {
      const message = `Source Control couldn't read pull requests: ${errorMessage(cause)}`;
      for (const ref of refs) reads.set(pullRequestRefKey(ref), { ok: false, reason: "unavailable", message });
    }
    return reads;
  }

  /** The diff query for a thread's target, with the environment it runs in. */
  async function resolveDiff(threadId: string, target: ChangesTarget) {
    const environment = await threadEnvironment(sdk, threadId);
    if (!environment.ok) return environment;
    const status = await workspaceStatus(sdk, environment.environmentId);
    if (!status.ok) return status;
    const { workspace, base } = status;
    const resolved = diffQuery(target, workspace.head, base, workspace.mergeBase?.commits ?? []);
    return { ok: true as const, environmentId: environment.environmentId, ...resolved };
  }

  /** On-demand patches for a snapshot, in file order, until they'd no longer fit. */
  async function snapshotPatches(
    environmentId: string,
    query: CheckoutTarget,
    files: readonly ChangedFile[],
  ): Promise<FilePatch[]> {
    const wanted = files
      .filter((file) => file.diff === "on-demand" && isRepositoryPath(file.path))
      .slice(0, MAX_SNAPSHOT_PATCH_FILES);
    const found: FilePatch[] = [];
    let bytes = 0;
    for (let start = 0; start < wanted.length && bytes < SNAPSHOT_BYTES; start += PATCH_BATCH) {
      const answer = await checkoutPatches(sdk, environmentId, query, wanted.slice(start, start + PATCH_BATCH));
      if (!answer.ok) break;
      for (const patch of answer.value.patches) {
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
    const answer = await checkoutFiles(sdk, environmentId, query);
    if (!answer.ok) return problemFailure(answer.problem);
    const listed = answer.value;
    const inline = new Set(listed.patches.map((patch) => patch.path));
    const all = listed.files.map((file) => changedFile(file, inline.has(file.path)));
    const files = all.filter(
      (file) => matchesPathFilter(file.path, filter) || (file.previousPath !== null && matchesPathFilter(file.previousPath, filter)),
    );
    const shown = new Set(files.map((file) => file.path));
    const patches = listed.patches.filter((patch) => shown.has(patch.path));
    const view: ChangesView = {
      ok: true,
      scope,
      files,
      totalFiles: all.length,
      filter,
      listTruncated: listed.truncated,
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
    const head = workspace.head;
    const mergeBase = workspace.mergeBase;
    // Source Control lists the branch's commits newest first, as Commits shows them.
    const commits = (mergeBase?.commits ?? []).map((commit) => ({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      subject: commit.subject,
      author: commit.author,
      authoredAt: commit.authoredAt,
    }));
    const branch = branchOf(head);
    return {
      ok: true,
      branch,
      checkout: head.kind,
      head: head.kind === "unborn" ? null : head.sha.slice(0, 7),
      base,
      onBase: branch === base,
      ahead: mergeBase?.ahead ?? null,
      behind: mergeBase?.behind ?? null,
      commits: commits.slice(0, MAX_COMMITS),
      // Source Control lists at most MAX_COMMITS.
      commitsTruncated: commits.length >= MAX_COMMITS,
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
        // A renamed file's patch needs its old path, which the file list knows.
        const listed = await checkoutFiles(sdk, resolved.environmentId, resolved.query);
        if (!listed.ok) return problemFailure(listed.problem);
        const wanted = new Set(paths);
        const files = listed.value.files.filter((file) => wanted.has(file.path));
        if (files.length === 0) return { ok: true, patches: [] };
        const answer = await checkoutPatches(sdk, resolved.environmentId, resolved.query, files);
        if (!answer.ok) return problemFailure(answer.problem);
        return { ok: true, patches: answer.value.patches };
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
          readPullRequest(sdk, environment.environmentId),
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

    async pullRequests(threadId, refs, refresh) {
      if (refs.length === 0 || refs.length > PULL_REQUESTS_SHOWN) {
        return failure("invalid", `PullRequest reads 1 to ${PULL_REQUESTS_SHOWN} pull requests at a time`);
      }
      try {
        // A thread with no environment still reads, with the bb server's GitHub accounts only.
        const environment = await threadEnvironment(sdk, threadId);
        if (!environment.ok && environment.reason !== "no-environment") return environment;
        const environmentId = environment.ok ? environment.environmentId : null;
        const cacheKey = (ref: PullRequestRef) => `${environmentId ?? ""}\0${pullRequestRefKey(ref).toLowerCase()}`;
        const now = Date.now();
        const missing = refs.filter((ref) => {
          const kept = pullRequestCache.get(cacheKey(ref));
          return refresh || kept === undefined || now - kept.at >= cacheAge(kept.read);
        });
        if (missing.length > 0) {
          const flightKey = `${environmentId ?? ""}\0${missing.map((ref) => pullRequestRefKey(ref).toLowerCase()).join(" ")}`;
          let flight = pullRequestReads.get(flightKey);
          if (flight === undefined) {
            flight = readPullRequestsByRef(environmentId, missing).finally(() => pullRequestReads.delete(flightKey));
            pullRequestReads.set(flightKey, flight);
          }
          const reads = await flight;
          const at = Date.now();
          for (const ref of missing) {
            const read = reads.get(pullRequestRefKey(ref));
            if (read === undefined) continue;
            const key = cacheKey(ref);
            pullRequestCache.delete(key);
            pullRequestCache.set(key, { at, read });
          }
          while (pullRequestCache.size > PULL_REQUEST_CACHE) pullRequestCache.delete(pullRequestCache.keys().next().value!);
        }
        let fetchedAt = now;
        const rows = refs.map((ref) => {
          const kept = pullRequestCache.get(cacheKey(ref));
          if (kept !== undefined) fetchedAt = Math.min(fetchedAt, kept.at);
          return {
            ref,
            read: kept?.read ?? { ok: false as const, reason: "unavailable" as const, message: "BB couldn't read this pull request" },
          };
        });
        return { ok: true, rows, fetchedAt };
      } catch (cause) {
        return failure("unavailable", `BB couldn't read the pull requests: ${errorMessage(cause)}`);
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
