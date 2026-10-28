// Environments: the reply's thread's project's environments with the threads
// on each (one cheap read for the first paint), and per environment its git
// status and pull request (read on request, for the rows on screen). Through
// the SDK only, and only inside the thread's own project: an environment of
// another project answers "not found" like an unknown one.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  byActivity,
  defaultEnvironments,
  ENVIRONMENT_ID,
  THREADS_PER_ENVIRONMENT,
  type CheckoutFailure,
  type CheckoutStatus,
  type EnvironmentDetail,
  type EnvironmentDetailResult,
  type EnvironmentInfo,
  type EnvironmentKind,
  type EnvironmentLife,
  type EnvironmentPull,
  type EnvironmentThread,
} from "../core/environments";
import { RUNNING, THREAD_ID, type EnvironmentsResult, type ProjectFailure, type ThreadDisplayStatus } from "../core/project";
import { pullRequestInfo } from "./source";

type Sdk = BbPluginApi["sdk"];

/** The fields of BB's environment record (environments.list/get) Environments reads. */
export interface EnvironmentEntry {
  readonly id: string;
  readonly name: string | null;
  readonly projectId: string;
  readonly path: string | null;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;
  readonly branchName: string | null;
  readonly defaultBranch: string | null;
  readonly mergeBaseBranch: string | null;
  readonly status: "creating" | "destroyed" | "error" | "provisioning" | "ready";
  readonly environmentProviderId: string | null;
  readonly lifecycle: { readonly phase: "active" | "destroyed" | "retiring" | "teardown" };
  readonly hostLifecycle: "active" | "cleanup-failed" | "removed" | "removing";
  readonly workspaceProvisionType: "managed-worktree" | "personal" | "unmanaged" | null;
  readonly updatedAt: number;
}

/** The fields of BB's thread list entry Environments reads. */
export interface ThreadEntry {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly environmentName: string | null;
  readonly environmentPath: string | null;
  readonly environmentBranchName: string | null;
  readonly environmentIsWorktree: boolean | null;
  readonly environmentProviderId: string | null;
  readonly title: string | null;
  readonly titleFallback: string | null;
  readonly runtime: { readonly displayStatus: ThreadDisplayStatus };
  readonly hasPendingInteraction: boolean;
  readonly archivedAt: number | null;
  readonly deletedAt: number | null;
  readonly parentThreadId: string | null;
  readonly latestAttentionAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The fields of environments.status's available workspace Environments reads. */
export interface WorkspaceEntry {
  readonly branch: { readonly defaultBranch: string };
  readonly checkout:
    | { readonly kind: "branch"; readonly branchName: string; readonly headSha: string | null }
    | { readonly kind: "detached"; readonly headSha: string | null }
    | { readonly kind: "unborn"; readonly branchName: string | null }
    | { readonly kind: "unknown"; readonly reason: string };
  readonly mergeBase: { readonly aheadCount: number; readonly behindCount: number } | null;
  readonly workingTree: {
    readonly files: readonly unknown[];
    readonly insertions: number;
    readonly deletions: number;
    readonly lineStatsComplete: boolean;
  };
}

/** environments.status when it couldn't read the checkout. */
export type UnreadStatus =
  | { readonly outcome: "not_applicable"; readonly message: string }
  | { readonly outcome: "unavailable"; readonly failure: { readonly code: string; readonly message: string; readonly workspacePath: string } };

/** Most threads of the project read for the list. */
export const MAX_PROJECT_THREADS = 1000;

/** Most environments of live threads that BB no longer lists (destroyed) looked up one by one. */
const MAX_MISSING_ENVIRONMENTS = 20;

/** Environments whose detail the markdown fallback reads, and how many at once. */
const MARKDOWN_DETAILS = 12;
const DETAIL_CONCURRENCY = 3;

/** How long a thread's project is reused before asking BB again. */
const PROJECT_CACHE_MS = 60_000;

export interface EnvironmentsSource {
  /** The list with threads; `withDetails` also reads the detail of the environments the default view shows (markdown). */
  environments(threadId: string, withDetails: boolean): Promise<EnvironmentsResult>;
  environment(threadId: string, environmentId: string): Promise<EnvironmentDetailResult>;
}

function failure(reason: ProjectFailure["reason"], message: string): ProjectFailure {
  return { ok: false, reason, message };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Where the environment is in its life, from BB's status, lifecycle phase and machine. */
export function environmentLife(environment: Pick<EnvironmentEntry, "status" | "lifecycle" | "hostLifecycle">): EnvironmentLife {
  if (environment.status === "destroyed" || environment.lifecycle.phase === "destroyed") return "destroyed";
  if (environment.hostLifecycle === "removed" || environment.hostLifecycle === "removing") return "host-gone";
  if (environment.lifecycle.phase === "retiring" || environment.lifecycle.phase === "teardown") return "retiring";
  if (environment.status === "creating" || environment.status === "provisioning") return "creating";
  if (environment.status === "error") return "error";
  return "ready";
}

/** The kind of place, as BB's environment picker names them. */
export function environmentKind(
  environment: Pick<EnvironmentEntry, "workspaceProvisionType" | "isWorktree" | "isGitRepo" | "environmentProviderId">,
  life: EnvironmentLife,
): EnvironmentKind {
  if (environment.workspaceProvisionType === "personal") return "personal";
  if (environment.workspaceProvisionType === "managed-worktree") return "managed-worktree";
  if (environment.isWorktree) return "worktree";
  const provider = environment.environmentProviderId;
  if (provider !== null && provider !== "project-checkout") return "other";
  // A destroyed environment no longer says whether it was a git checkout.
  if (!environment.isGitRepo && life !== "destroyed") return "folder";
  return "checkout";
}

/** A thread as a row line; `activeAt` comes from latestActivity. */
export function environmentThread(thread: ThreadEntry, activeAt: number): EnvironmentThread {
  return {
    id: thread.id,
    title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread",
    status: thread.runtime.displayStatus,
    needsInput: thread.hasPendingInteraction,
    archived: thread.archivedAt !== null,
    subthread: thread.parentThreadId !== null,
    activeAt,
  };
}

/**
 * When the thread last did something. BB moves `updatedAt` when the thread is
 * read, so it isn't activity: the last time the thread asked for attention
 * (finished a turn, asked a question) is. A running thread's latest event is newer.
 */
async function latestActivity(sdk: Sdk, thread: ThreadEntry): Promise<number> {
  const settled = Math.max(thread.latestAttentionAt, thread.createdAt);
  if (!RUNNING[thread.runtime.displayStatus] || thread.archivedAt !== null) return settled;
  const [latest] = await sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1" }).catch(() => []);
  return Math.max(settled, latest?.createdAt ?? 0);
}

/** One environment's row: its BB record and the threads on it. */
export function environmentInfo(
  environment: EnvironmentEntry,
  threads: readonly EnvironmentThread[],
  currentEnvironmentId: string | null,
): EnvironmentInfo {
  const life = environmentLife(environment);
  // Live threads before archived ones; among live ones, those running or waiting for the user first; then newest first.
  const busy = (thread: EnvironmentThread) => !thread.archived && (RUNNING[thread.status] || thread.needsInput);
  const sorted = [...threads].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || Number(busy(b)) - Number(busy(a)) || b.activeAt - a.activeAt,
  );
  const live = sorted.filter((thread) => !thread.archived);
  const newest = threads.reduce((latest, thread) => Math.max(latest, thread.activeAt), 0);
  return {
    id: environment.id,
    name: environment.name,
    kind: environmentKind(environment, life),
    provider: environment.environmentProviderId,
    path: environment.path,
    branch: environment.branchName,
    defaultBranch: environment.defaultBranch,
    base: environment.mergeBaseBranch ?? environment.defaultBranch,
    git: environment.isGitRepo,
    life,
    current: environment.id === currentEnvironmentId,
    threads: sorted.slice(0, THREADS_PER_ENVIRONMENT),
    threadCounts: {
      total: threads.length,
      live: live.length,
      running: live.filter((thread) => RUNNING[thread.status]).length,
      needsInput: live.filter((thread) => thread.needsInput).length,
    },
    activeAt: newest > 0 ? newest : null,
    updatedAt: environment.updatedAt,
    detail: null,
  };
}

/** A live thread's environment BB no longer has at all: what the thread itself remembers of it. */
function vanishedEnvironment(thread: ThreadEntry): EnvironmentEntry {
  return {
    id: thread.environmentId ?? "",
    name: thread.environmentName,
    projectId: thread.projectId,
    path: thread.environmentPath,
    isGitRepo: false,
    isWorktree: thread.environmentIsWorktree === true,
    branchName: thread.environmentBranchName,
    defaultBranch: null,
    mergeBaseBranch: null,
    status: "destroyed",
    environmentProviderId: thread.environmentProviderId,
    lifecycle: { phase: "destroyed" },
    hostLifecycle: "active",
    workspaceProvisionType: null,
    updatedAt: thread.updatedAt,
  };
}

/** A checkout Environments couldn't read, and why. */
function unread(reason: CheckoutFailure["reason"], message: string, path: string | null = null): CheckoutFailure {
  return { ok: false, reason, message, path };
}

/** BB's answer for a checkout it couldn't read, as Environments says it. */
export function checkoutFailure(answer: UnreadStatus): CheckoutFailure {
  if (answer.outcome === "not_applicable") return unread("not-git", "Not a git checkout");
  switch (answer.failure.code) {
    case "path_not_found":
      return unread("missing", "Workspace folder is gone", answer.failure.workspacePath);
    case "not_git_repo":
    case "workspace_type_mismatch":
      return unread("not-git", "Not a git checkout");
    case "unknown_environment":
      return unread("gone", "BB no longer knows this environment");
    default:
      return unread("unavailable", answer.failure.message, answer.failure.workspacePath);
  }
}

/** environments.status as Environments shows it, measured against `base`. */
export function checkoutStatus(workspace: WorkspaceEntry, base: string): CheckoutStatus {
  const checkout = workspace.checkout;
  const branch = checkout.kind === "branch" ? checkout.branchName : checkout.kind === "unborn" ? checkout.branchName : null;
  const head = checkout.kind === "branch" || checkout.kind === "detached" ? (checkout.headSha?.slice(0, 7) ?? null) : null;
  const onBase = branch === base;
  const mergeBase = onBase ? null : workspace.mergeBase;
  const tree = workspace.workingTree;
  return {
    ok: true,
    branch,
    checkout: checkout.kind,
    head,
    defaultBranch: workspace.branch.defaultBranch,
    base,
    onBase,
    ahead: mergeBase?.aheadCount ?? null,
    behind: mergeBase?.behindCount ?? null,
    uncommitted: { files: tree.files.length, additions: tree.insertions, deletions: tree.deletions, complete: tree.lineStatsComplete },
  };
}

/** Runs `work` on each item, at most `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createEnvironmentsSource(sdk: Sdk): EnvironmentsSource {
  const projects = new Map<string, { at: number; projectId: string; environmentId: string | null }>();

  /** The thread's project and environment, or why there is none. */
  async function ownThread(threadId: string) {
    if (!THREAD_ID.test(threadId)) return failure("invalid", `"${threadId}" is not a thread id`);
    const cached = projects.get(threadId);
    if (cached !== undefined && Date.now() - cached.at < PROJECT_CACHE_MS) return { ok: true as const, ...cached };
    let thread;
    try {
      thread = await sdk.threads.get({ threadId });
    } catch {
      return failure("not-found", "BB has no such thread");
    }
    if (thread.deletedAt !== null) return failure("not-found", "This thread was deleted");
    const own = { at: Date.now(), projectId: thread.projectId, environmentId: thread.environmentId };
    projects.set(threadId, own);
    return { ok: true as const, ...own };
  }

  async function readCheckout(environment: EnvironmentEntry): Promise<Pick<EnvironmentDetail, "checkout" | "pull">> {
    const life = environmentLife(environment);
    if (life === "destroyed") return { checkout: unread("gone", "This environment was destroyed"), pull: null };
    if (life === "host-gone") return { checkout: unread("unavailable", "The machine it was on was removed"), pull: null };
    if (!environment.isGitRepo) return { checkout: unread("not-git", "Not a git checkout"), pull: null };
    const environmentId = environment.id;
    let base = environment.mergeBaseBranch ?? environment.defaultBranch;
    let status = await sdk.environments.status({ environmentId, ...(base === null ? {} : { mergeBaseBranch: base }) });
    if (status.outcome !== "available") return { checkout: checkoutFailure(status), pull: null };
    if (base === null) {
      base = status.workspace.branch.defaultBranch;
      status = await sdk.environments.status({ environmentId, mergeBaseBranch: base });
      if (status.outcome !== "available") return { checkout: checkoutFailure(status), pull: null };
    }
    const checkout = checkoutStatus(status.workspace, base);
    // Only a branch of its own has a pull request: not the default branch, its base, or a detached HEAD.
    if (checkout.checkout !== "branch" || checkout.onBase || checkout.branch === checkout.defaultBranch) return { checkout, pull: null };
    return { checkout, pull: await readPull(environmentId) };
  }

  async function readPull(environmentId: string): Promise<EnvironmentPull> {
    try {
      const answer = await sdk.environments.pullRequest({ environmentId });
      if (answer.outcome === "unavailable") return { ok: false, message: answer.message };
      return { ok: true, pullRequest: answer.outcome === "available" ? pullRequestInfo(answer.pullRequest) : null };
    } catch (cause) {
      return { ok: false, message: errorMessage(cause) };
    }
  }

  async function detailOf(environment: EnvironmentEntry): Promise<EnvironmentDetail> {
    try {
      return { ok: true, id: environment.id, ...(await readCheckout(environment)), fetchedAt: Date.now() };
    } catch (cause) {
      return {
        ok: true,
        id: environment.id,
        checkout: unread("unavailable", `BB couldn't read the checkout: ${errorMessage(cause)}`),
        pull: null,
        fetchedAt: Date.now(),
      };
    }
  }

  return {
    async environments(threadId, withDetails) {
      try {
        const own = await ownThread(threadId);
        if (!own.ok) return own;
        const { projectId } = own;
        const [listed, threads] = await Promise.all([
          sdk.environments.list({ projectId }),
          sdk.threads.list({ projectId, limit: MAX_PROJECT_THREADS + 1 }),
        ]);
        const environments = new Map<string, EnvironmentEntry>(
          listed.filter((environment) => environment.projectId === projectId).map((environment) => [environment.id, environment]),
        );
        const kept = threads.filter((thread) => thread.projectId === projectId && thread.deletedAt === null && thread.environmentId !== null);
        const read = kept.slice(0, MAX_PROJECT_THREADS);
        // BB doesn't list destroyed environments; one a live thread still points at is shown, honestly.
        const missing = [
          ...new Map(
            read
              .filter((thread) => thread.archivedAt === null && !environments.has(thread.environmentId ?? ""))
              .map((thread) => [thread.environmentId ?? "", thread]),
          ).values(),
        ].slice(0, MAX_MISSING_ENVIRONMENTS);
        const found = await mapLimit(missing, DETAIL_CONCURRENCY, async (thread) => {
          const environment = await sdk.environments.get({ environmentId: thread.environmentId ?? "" }).catch(() => null);
          if (environment !== null && environment.projectId !== projectId) return null;
          return environment ?? vanishedEnvironment(thread);
        });
        for (const environment of found) if (environment !== null) environments.set(environment.id, environment);

        const byEnvironment = new Map<string, EnvironmentThread[]>();
        const rows = await mapLimit(read, 8, async (thread) => environmentThread(thread, await latestActivity(sdk, thread)));
        rows.forEach((row, index) => {
          const environmentId = read[index]?.environmentId ?? "";
          if (!environments.has(environmentId)) return;
          const list = byEnvironment.get(environmentId) ?? [];
          list.push(row);
          byEnvironment.set(environmentId, list);
        });
        const infos = [...environments.values()]
          .map((environment) => environmentInfo(environment, byEnvironment.get(environment.id) ?? [], own.environmentId))
          .sort(byActivity);
        const view = { ok: true as const, environments: infos, threadsTruncated: kept.length > MAX_PROJECT_THREADS, fetchedAt: Date.now() };
        if (!withDetails) return view;
        const wanted = defaultEnvironments(infos).shown.slice(0, MARKDOWN_DETAILS);
        const details = new Map(
          (await mapLimit(wanted, DETAIL_CONCURRENCY, (info) => detailOf(environments.get(info.id) as EnvironmentEntry))).map((detail) => [detail.id, detail]),
        );
        return { ...view, environments: infos.map((info) => ({ ...info, detail: details.get(info.id) ?? null })) };
      } catch (cause) {
        return failure("unavailable", `BB couldn't list the environments: ${errorMessage(cause)}`);
      }
    },

    async environment(threadId, environmentId) {
      if (!ENVIRONMENT_ID.test(environmentId)) return { ok: false, reason: "invalid", message: `"${environmentId}" is not an environment id` };
      try {
        const own = await ownThread(threadId);
        if (!own.ok) return { ok: false, reason: own.reason === "invalid" ? "invalid" : "not-found", message: own.message };
        const environment = await sdk.environments.get({ environmentId }).catch(() => null);
        // Another project's environment is as invisible here as an unknown one.
        if (environment === null || environment.projectId !== own.projectId) {
          return { ok: false, reason: "not-found", message: "No such environment in this project" };
        }
        return await detailOf(environment);
      } catch (cause) {
        return { ok: false, reason: "unavailable", message: `BB couldn't read the environment: ${errorMessage(cause)}` };
      }
    },
  };
}
