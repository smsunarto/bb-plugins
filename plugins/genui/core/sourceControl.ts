// Local (bb-plugins): a thread's pull request as Source Control's
// `statusForThread` row gives it, the one place GenUI reads pull request
// data. The row is parsed leniently, keeping only the fields read here, so
// a field Source Control adds never fails it. Nothing here talks to BB.
import type { PullRequestState } from "./project";

export const SOURCE_CONTROL_PLUGIN_ID = "source-control";

/** Most thread ids one `statusForThread` read takes. */
export const MAX_STATUS_KEYS = 200;

/** The tag Source Control invalidates when a thread's row changes. */
export const threadTag = (threadId: string): string => `thread:${threadId}`;

export type StatusTone = "neutral" | "warning" | "error" | "success" | "merged";

export interface ThreadPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PullRequestState;
}

/**
 * Whether the row's pull request is GitHub's answer, when the row says.
 * `unknown`: the row doesn't say (Source Control before BBP-32), so a null
 * pull request may mean none or not read yet. Otherwise Source Control's own
 * states: `failed` keeps the last good read's time, if any.
 */
export type ForgeRead =
  | { readonly state: "unknown" }
  | { readonly state: "unread" }
  | { readonly state: "read"; readonly at: number }
  | { readonly state: "failed"; readonly at: number | null; readonly problem: string }
  | { readonly state: "unsupported" };

export type ThreadStatus =
  | { readonly state: "pending" }
  | { readonly state: "none" }
  | {
      readonly state: "change";
      readonly branch: string | null;
      readonly pullRequest: ThreadPullRequest | null;
      /** Source Control's status line for the Change ("Checks failing", "Ready to merge"). */
      readonly line: string;
      readonly tone: StatusTone;
      readonly forge: ForgeRead;
    };

const TONES: ReadonlySet<string> = new Set(["neutral", "warning", "error", "success", "merged"]);
const PR_STATES: ReadonlySet<string> = new Set(["open", "draft", "merged", "closed"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function pullRequestOf(value: unknown): ThreadPullRequest | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { number, title, url, state } = value;
  if (
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof state !== "string" ||
    !PR_STATES.has(state)
  )
    return undefined;
  return { number, title, url, state: state as PullRequestState };
}

function problemText(value: unknown): string {
  if (!isRecord(value)) return "Source Control couldn't read the pull request";
  if (typeof value.detail === "string" && value.detail !== "") return value.detail;
  switch (value.kind) {
    case "host-offline":
      return `${typeof value.host === "string" ? value.host : "Its machine"} is offline`;
    case "auth":
      return "GitHub isn't signed in for Source Control";
    case "rate-limited":
      return "GitHub is rate-limiting Source Control";
    case "no-site":
      return "No machine with a signed-in gh can read GitHub";
    default:
      return "Source Control couldn't read the pull request";
  }
}

function forgeOf(value: unknown): ForgeRead {
  if (!isRecord(value)) return { state: "unknown" };
  switch (value.state) {
    case "unread":
      return { state: "unread" };
    case "unsupported":
      return { state: "unsupported" };
    case "read":
      return typeof value.at === "number" ? { state: "read", at: value.at } : { state: "unknown" };
    case "failed":
      return {
        state: "failed",
        at: typeof value.at === "number" ? value.at : null,
        problem: problemText(value.problem),
      };
    default:
      return { state: "unknown" };
  }
}

/** One `statusForThread` row, or null when it isn't one. */
export function parseThreadStatus(value: unknown): ThreadStatus | null {
  if (!isRecord(value)) return null;
  if (value.state === "pending" || value.state === "none") return { state: value.state };
  if (value.state !== "change") return null;
  const pullRequest = pullRequestOf(value.pullRequest);
  const { branch, line, tone } = value;
  if (
    pullRequest === undefined ||
    typeof line !== "string" ||
    (branch !== null && typeof branch !== "string")
  )
    return null;
  return {
    state: "change",
    branch,
    pullRequest,
    line,
    tone: typeof tone === "string" && TONES.has(tone) ? (tone as StatusTone) : "neutral",
    forge: forgeOf(value.forge),
  };
}

/** A `statusForThread` answer, keyed by thread id; rows that don't parse are left out. */
export function parseThreadStatuses(value: unknown): Record<string, ThreadStatus> {
  const rows: Record<string, ThreadStatus> = {};
  if (!isRecord(value)) return rows;
  for (const [threadId, row] of Object.entries(value)) {
    const status = parseThreadStatus(row);
    if (status !== null) rows[threadId] = status;
  }
  return rows;
}

/** The branch's pull request as Source Control's rows for the threads on its checkout say. */
export type EnvironmentPull =
  | {
      readonly ok: true;
      readonly pullRequest: ThreadPullRequest | null;
      readonly line: string;
      readonly tone: StatusTone;
      readonly forge: ForgeRead;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The pull request of `branch` from the rows of the threads on its checkout,
 * newest thread first: the first row on the branch with a pull request, else
 * the first row on the branch; with none, why Source Control can't say.
 */
export function environmentPull(
  threadIds: readonly string[],
  rows: Readonly<Record<string, ThreadStatus>>,
  branch: string,
): EnvironmentPull {
  if (threadIds.length === 0)
    return {
      ok: false,
      message: "No thread on this environment, so Source Control has no pull request for it",
    };
  const known = threadIds.flatMap((id) => (rows[id] === undefined ? [] : [rows[id]]));
  const onBranch = known.flatMap((row) =>
    row.state === "change" && row.branch === branch ? [row] : [],
  );
  const row = onBranch.find((candidate) => candidate.pullRequest !== null) ?? onBranch[0];
  if (row !== undefined)
    return {
      ok: true,
      pullRequest: row.pullRequest,
      line: row.line,
      tone: row.tone,
      forge: row.forge,
    };
  if (known.some((candidate) => candidate.state === "pending") || known.length < threadIds.length) {
    return { ok: false, message: "Source Control hasn't read this environment's threads yet" };
  }
  return { ok: false, message: `Source Control has no thread on ${branch}` };
}

/** What a pull request fact says when there is none: as much as the row knows. */
export function noPullLabel(forge: ForgeRead): string {
  switch (forge.state) {
    case "read":
      return "no PR";
    case "unread":
      return "PR not read yet";
    case "failed":
      return forge.at === null ? "PR unknown" : "no PR";
    case "unsupported":
      return "no GitHub PR";
    default:
      return "no PR seen";
  }
}

/** When Source Control last read the pull request, and whether that read failed since; null when the row doesn't say. */
export function forgeReadAt(
  forge: ForgeRead,
): { readonly at: number | null; readonly failed: string | null } | null {
  if (forge.state === "read") return { at: forge.at, failed: null };
  if (forge.state === "failed") return { at: forge.at, failed: forge.problem };
  return null;
}

/** A pull request a retired `PullRequest(refs)` names: `owner/repo#1` or a github.com pull URL. */
export interface PullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

/** The pull request `ref` names, or null for text that names none. */
export function parsePullRequestRef(ref: string): PullRequestRef | null {
  const text = ref.trim();
  const match =
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(text) ??
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/i.exec(text);
  if (match === null) return null;
  const [, owner = "", repo = "", number = ""] = match;
  return {
    owner,
    repo,
    number: Number(number),
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

/** Whether `pr` (a Source Control row's) is the pull request `ref` names. */
export function samePullRequest(ref: PullRequestRef, pr: ThreadPullRequest): boolean {
  const named = parsePullRequestRef(pr.url);
  return (
    named !== null &&
    named.number === ref.number &&
    named.owner.toLowerCase() === ref.owner.toLowerCase() &&
    named.repo.toLowerCase() === ref.repo.toLowerCase()
  );
}
