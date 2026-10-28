// What Environments shows: the reply's thread's project's environments (the
// project checkout, worktrees, other workspaces) with the threads on each,
// and per environment its git status and pull request, read lazily. The
// shapes the backend (project/environments.ts) answers with, which the
// renderer and the markdown fallback both read, and the pure helpers they
// share. Nothing here talks to BB.
import type { PullRequestInfo, ThreadDisplayStatus } from "./project";

/** BB environment ids: `env_` and lowercase letters and digits. */
export const ENVIRONMENT_ID = /^env_[a-z0-9]{4,40}$/;

/** Threads per environment the list carries (newest first); the counts cover all of them. */
export const THREADS_PER_ENVIRONMENT = 5;

/** What kind of place the environment is, as BB's environment picker names them. */
export type EnvironmentKind = "checkout" | "worktree" | "managed-worktree" | "personal" | "folder" | "other";

/**
 * Where the environment is in its life. `creating`: BB is still making it;
 * `retiring`: BB will remove it (its threads are archived); `destroyed`: its
 * workspace is gone for good; `host-gone`: the machine it lived on was removed.
 */
export type EnvironmentLife = "ready" | "creating" | "error" | "retiring" | "destroyed" | "host-gone";

export interface EnvironmentThread {
  readonly id: string;
  readonly title: string;
  readonly status: ThreadDisplayStatus;
  /** The thread waits for the user to answer a question or approve something. */
  readonly needsInput: boolean;
  readonly archived: boolean;
  /** Spawned by another thread. */
  readonly subthread: boolean;
  /** Epoch ms the thread last did something. */
  readonly activeAt: number;
}

export interface EnvironmentInfo {
  readonly id: string;
  /** The name the user gave it, if any. */
  readonly name: string | null;
  readonly kind: EnvironmentKind;
  /** The environment provider's id (`project-checkout`, `git-worktree`, a plugin's), for kind "other". */
  readonly provider: string | null;
  readonly path: string | null;
  /** The branch BB last saw checked out. */
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  /** What ahead/behind is measured against: the environment's merge-base branch, else the default branch. */
  readonly base: string | null;
  readonly git: boolean;
  readonly life: EnvironmentLife;
  /** The reply's own thread runs here. */
  readonly current: boolean;
  /** Up to THREADS_PER_ENVIRONMENT threads: live before archived, running or waiting for the user first, then newest activity first. */
  readonly threads: readonly EnvironmentThread[];
  readonly threadCounts: { readonly total: number; readonly live: number; readonly running: number; readonly needsInput: number };
  /** Epoch ms of the newest thread activity; null without threads. */
  readonly activeAt: number | null;
  /** Epoch ms BB last changed the environment's record (orders environments without threads). */
  readonly updatedAt: number;
  /** Git status and pull request, when read with the list (the markdown fallback); null: ask project_environment. */
  readonly detail: EnvironmentDetail | null;
}

export interface EnvironmentsView {
  readonly ok: true;
  /** Newest activity first. */
  readonly environments: readonly EnvironmentInfo[];
  /** BB had more threads than were read, so thread counts may be short. */
  readonly threadsTruncated: boolean;
  readonly fetchedAt: number;
}

/** Why an environment's checkout couldn't be read. */
export interface CheckoutFailure {
  readonly ok: false;
  /** `missing`: the workspace folder no longer exists; `gone`: the environment was destroyed. */
  readonly reason: "missing" | "gone" | "not-git" | "unavailable";
  readonly message: string;
  /** The workspace folder BB looked for, when it is missing. */
  readonly path: string | null;
}

export interface CheckoutStatus {
  readonly ok: true;
  /** Null when detached or unknown. */
  readonly branch: string | null;
  readonly checkout: "branch" | "detached" | "unborn" | "unknown";
  /** Short sha of HEAD. */
  readonly head: string | null;
  readonly defaultBranch: string;
  readonly base: string;
  /** The checkout is on its base branch. */
  readonly onBase: boolean;
  /** Null when BB found no merge base. */
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly uncommitted: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
    /** False when git couldn't count lines for some files (binary, too large). */
    readonly complete: boolean;
  };
}

/** The branch's pull request: null when it has none or none was looked for (on the base branch, detached). */
export type EnvironmentPull =
  | { readonly ok: true; readonly pullRequest: PullRequestInfo | null }
  | { readonly ok: false; readonly message: string };

export interface EnvironmentDetail {
  readonly ok: true;
  readonly id: string;
  readonly checkout: CheckoutStatus | CheckoutFailure;
  /** Null when not asked (no branch of its own, or the checkout couldn't be read). */
  readonly pull: EnvironmentPull | null;
  readonly fetchedAt: number;
}

/** BB's answer for one environment's detail, or why there is none (not in this project, bad id). */
export type EnvironmentDetailResult = EnvironmentDetail | { readonly ok: false; readonly reason: "not-found" | "invalid" | "unavailable"; readonly message: string };

// ── Shared wording and ordering ─────────────────────────────────────────────

export const KIND_LABEL: Record<EnvironmentKind, string> = {
  checkout: "Project checkout",
  worktree: "Worktree",
  "managed-worktree": "Managed worktree",
  personal: "Personal workspace",
  folder: "Folder",
  other: "Environment",
};

export const LIFE_LABEL: Record<EnvironmentLife, string | null> = {
  ready: null,
  creating: "Being created",
  error: "Failed to set up",
  retiring: "Being removed",
  destroyed: "Destroyed",
  "host-gone": "Machine removed",
};

/** The last segment of a workspace path ("orbit-web"), or null. */
export function folderName(path: string | null): string | null {
  return path?.split(/[\\/]/).filter((segment) => segment !== "").pop() ?? null;
}

/** What names an environment in a row: its branch, else its name, else its folder, else its id. */
export function environmentTitle(environment: EnvironmentInfo): string {
  return environment.branch ?? environment.name ?? folderName(environment.path) ?? environment.id;
}

/** "Project checkout · orbit-operator": the kind, with the folder for checkouts (a project may have several), or the provider for other kinds. */
export function kindLabel(environment: EnvironmentInfo): string {
  if (environment.kind === "other" && environment.provider !== null) return environment.provider;
  const folder = environment.kind === "checkout" ? folderName(environment.path) : null;
  return folder === null || folder === environment.branch ? KIND_LABEL[environment.kind] : `${KIND_LABEL[environment.kind]} · ${folder}`;
}

/** The environment's live (not archived) threads, in the list's order. */
export function liveThreads(environment: EnvironmentInfo): readonly EnvironmentThread[] {
  return environment.threads.filter((thread) => !thread.archived);
}

/** The thread a row opens: the first live one (a running or waiting one, else the newest), else the newest archived one; null when none. */
export function openingThread(environment: EnvironmentInfo): EnvironmentThread | null {
  return liveThreads(environment)[0] ?? environment.threads[0] ?? null;
}

/** Newest thread activity first, environments without threads after (newest change first); ties by id so the order holds between reads. */
export function byActivity(a: EnvironmentInfo, b: EnvironmentInfo): number {
  return (b.activeAt ?? -1) - (a.activeAt ?? -1) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** What the default view shows: environments with live threads. All of them when none has one. */
export function defaultEnvironments(environments: readonly EnvironmentInfo[]): { readonly shown: readonly EnvironmentInfo[]; readonly filtered: boolean } {
  const live = environments.filter((environment) => environment.threadCounts.live > 0);
  return live.length === 0 ? { shown: environments, filtered: false } : { shown: live, filtered: live.length < environments.length };
}

/** "2 running · 1 needs input · 3 live · 4 archived" for a row's quiet summary. */
export function threadSummary(environment: EnvironmentInfo): string {
  const { total, live, running, needsInput } = environment.threadCounts;
  if (total === 0) return "No threads";
  const archived = total - live;
  return [
    running > 0 ? `${running} running` : "",
    needsInput > 0 ? `${needsInput} need${needsInput === 1 ? "s" : ""} input` : "",
    live > 0 ? `${live} live` : "",
    archived > 0 ? `${archived} archived` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

const COUNT = new Intl.NumberFormat("en-US");

/** "3 ahead, 1 behind main", "even with main", or "" when unknown or on the base branch. */
export function aheadBehindLabel(status: CheckoutStatus): string {
  if (status.onBase || status.ahead === null || status.behind === null) return "";
  if (status.ahead === 0 && status.behind === 0) return `even with ${status.base}`;
  return `${COUNT.format(status.ahead)} ahead, ${COUNT.format(status.behind)} behind ${status.base}`;
}

/** "4 files +1,120 −8 uncommitted", "clean". */
export function uncommittedLabel(status: CheckoutStatus): string {
  const { files, additions, deletions } = status.uncommitted;
  if (files === 0) return "clean";
  return `${COUNT.format(files)} file${files === 1 ? "" : "s"} +${COUNT.format(additions)} −${COUNT.format(deletions)} uncommitted`;
}
