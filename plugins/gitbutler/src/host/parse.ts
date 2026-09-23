import { createHash } from "node:crypto";
import type {
  BaseCommit,
  Branch,
  BranchStatus,
  Commit,
  CommitDetails,
  FileChange,
  FilePatch,
  Patches,
  Stack,
  Workspace,
} from "../shared/schema.ts";

/**
 * `but status --json` to the wire model. Everything here is defensive
 * narrowing: the CLI owns its own schema and can add fields or statuses, so
 * an unrecognised value degrades to a neutral one instead of failing the
 * whole panel.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const CHANGE_KINDS = new Set(["added", "modified", "deleted", "renamed", "copied"]);

function fileChange(value: unknown): FileChange | undefined {
  const record = asObject(value);
  const path = asString(record?.["filePath"] ?? record?.["path"]);
  if (path === "") return undefined;
  const raw = asString(record?.["changeType"] ?? record?.["status"], "modified");
  return { path, kind: CHANGE_KINDS.has(raw) ? (raw as FileChange["kind"]) : "modified" };
}

function fileChanges(value: unknown): FileChange[] {
  return asArray(value).flatMap((entry) => {
    const change = fileChange(entry);
    return change ? [change] : [];
  });
}

function commit(value: unknown): Commit | undefined {
  const record = asObject(value);
  const commitId = asString(record?.["commitId"]);
  if (commitId === "") return undefined;
  return {
    commitId,
    changeId: asNullableString(record?.["changeId"]),
    message: asString(record?.["message"]),
    authorName: asString(record?.["authorName"]),
    authorEmail: asString(record?.["authorEmail"]),
    createdAt: asString(record?.["createdAt"]),
    conflicted: record?.["conflicted"] === true,
    reviewId: asNullableString(record?.["reviewId"]),
  };
}

function commits(value: unknown): Commit[] {
  return asArray(value).flatMap((entry) => {
    const parsed = commit(entry);
    return parsed ? [parsed] : [];
  });
}

/** GitButler's `branchStatus` strings, mapped onto the panel's vocabulary. */
const BRANCH_STATUS: Readonly<Record<string, BranchStatus>> = {
  completelyUnpushed: "unpushed",
  unpushedCommits: "diverged",
  nothingToPush: "pushed",
  remoteAhead: "diverged",
  integrated: "integrated",
  fullyIntegrated: "integrated",
  conflicted: "conflicted",
  empty: "empty",
};

function branch(value: unknown): Branch | undefined {
  const record = asObject(value);
  const name = asString(record?.["name"]);
  if (name === "") return undefined;
  const rawStatus = asString(record?.["branchStatus"], "unknown");
  const ci = asObject(record?.["ci"]);
  return {
    name,
    status: BRANCH_STATUS[rawStatus] ?? "unknown",
    rawStatus,
    reviewId: asNullableString(record?.["reviewId"]),
    ci: ci ? asNullableString(ci["status"] ?? ci["state"]) : asNullableString(record?.["ci"]),
    commits: commits(record?.["commits"]),
    upstreamCommits: commits(record?.["upstreamCommits"]),
  };
}

function stack(value: unknown): Stack | undefined {
  const record = asObject(value);
  const branches = asArray(record?.["branches"]).flatMap((entry) => {
    const parsed = branch(entry);
    return parsed ? [parsed] : [];
  });
  if (branches.length === 0) return undefined;
  // CLI ids are reassigned on every invocation, so the bottom branch name is
  // the only identity stable enough for React keys and selection.
  return {
    key: branches.at(-1)!.name,
    branches,
    assignedChanges: fileChanges(record?.["assignedChanges"]),
  };
}

export function baseCommit(value: unknown): BaseCommit | undefined {
  const record = asObject(value);
  const commitId = asString(record?.["commitId"]);
  if (commitId === "") return undefined;
  return {
    commitId,
    message: asString(record?.["message"]),
    authorName: asString(record?.["authorName"]),
    createdAt: asString(record?.["createdAt"]),
  };
}

function revisionOf(workspace: Omit<Workspace, "revision">): string {
  return createHash("sha256").update(JSON.stringify(workspace)).digest("hex").slice(0, 16);
}

export function parseWorkspace(payload: unknown, repoName: string): Workspace {
  const root = asObject(payload) ?? {};
  const upstreamState = asObject(root["upstreamState"]);
  const behind = typeof upstreamState?.["behind"] === "number" ? upstreamState["behind"] : 0;
  const withoutRevision: Omit<Workspace, "revision"> = {
    state: "ready",
    reason: null,
    repoName,
    unassignedChanges: fileChanges(root["uncommittedChanges"]),
    stacks: asArray(root["stacks"]).flatMap((entry) => {
      const parsed = stack(entry);
      return parsed ? [parsed] : [];
    }),
    base: baseCommit(root["mergeBase"]) ?? null,
    upstream: upstreamState
      ? {
          behind: Math.max(0, Math.trunc(behind)),
          latestCommitId: baseCommit(upstreamState["latestCommit"])?.commitId ?? null,
          lastFetched: asNullableString(upstreamState["lastFetched"]),
        }
      : null,
  };
  return { ...withoutRevision, revision: revisionOf(withoutRevision) };
}

/** `but show --json` to the detail view's extra fields. */
export function parseCommitDetails(payload: unknown, commitId: string): CommitDetails {
  const root = asObject(payload) ?? {};
  const author = asObject(root["author"]);
  return {
    commitId: asString(root["commit"], commitId),
    message: asString(root["message"]),
    authorName: asString(author?.["name"]),
    authorEmail: asString(author?.["email"]),
    files: fileChanges(root["files"]),
  };
}

/**
 * git's own header lines for one change. Pierre parses a real git patch, so
 * the hunk bodies `but diff --json` returns are not enough on their own: the
 * `diff --git` and `---`/`+++` lines are what name the file, and the filename
 * is what selects the syntax highlighter.
 */
function patchHeader(path: string, previousPath: string, status: string): string {
  const lines = [`diff --git a/${previousPath} b/${path}`];
  if (status === "added") lines.push("new file mode 100644");
  else if (status === "deleted") lines.push("deleted file mode 100644");
  else if (previousPath !== path) lines.push(`rename from ${previousPath}`, `rename to ${path}`);
  lines.push(
    status === "added" ? "--- /dev/null" : `--- a/${previousPath}`,
    status === "deleted" ? "+++ /dev/null" : `+++ b/${path}`,
    "",
  );
  return lines.join("\n");
}

/**
 * Hunk bodies up to a character budget. The cut lands on a hunk boundary so
 * what Pierre receives is still a patch it can parse; a single hunk larger
 * than the whole budget falls back to the last line boundary inside it.
 */
function patchBody(hunks: readonly string[], maxChars: number) {
  let body = "";
  for (const hunk of hunks) {
    if (body.length + hunk.length <= maxChars) {
      body += hunk;
      continue;
    }
    const cut = body === "" ? hunk.slice(0, hunk.lastIndexOf("\n", maxChars) + 1) : body;
    return { body: cut, truncated: true };
  }
  return { body, truncated: false };
}

/** `@@ -old +new @@` start lines, so regrouped hunks stay in file order. */
function hunkOrder(hunk: string): [number, number] {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk);
  return match ? [Number(match[1]), Number(match[2])] : [Number.MAX_SAFE_INTEGER, 0];
}

type Grouped = {
  change: FileChange;
  previousPath: string;
  status: string;
  binary: boolean;
  hunks: string[];
};

/**
 * `but diff --json` emits one record per hunk, each carrying the change id
 * GitButler commits by, so a file with six edits arrives six times. The panel
 * shows files, not hunks, so they are folded back together here and re-sorted
 * into file order.
 */
function groupByPath(payload: unknown): Grouped[] {
  const groups = new Map<string, Grouped>();
  for (const entry of asArray(asObject(payload)?.["changes"])) {
    const record = asObject(entry);
    const change = record && fileChange(record);
    if (!record || !change) continue;

    let group = groups.get(change.path);
    if (!group) {
      group = {
        change,
        previousPath: asString(record["previousPath"] ?? record["oldPath"], change.path),
        status: asString(record["status"] ?? record["changeType"]),
        binary: false,
        hunks: [],
      };
      groups.set(change.path, group);
    }
    const diff = asObject(record["diff"]);
    if (diff && asString(diff["type"]) !== "patch") {
      group.binary = true;
      continue;
    }
    for (const hunk of asArray(diff?.["hunks"])) {
      const text = asString(asObject(hunk)?.["diff"]);
      if (text !== "") group.hunks.push(text);
    }
  }
  for (const group of groups.values()) {
    group.hunks.sort((left, right) => {
      const [leftOld, leftNew] = hunkOrder(left);
      const [rightOld, rightNew] = hunkOrder(right);
      return leftOld - rightOld || leftNew - rightNew;
    });
  }
  return [...groups.values()];
}

/**
 * `but diff --json` to one complete git patch per file. The panel renders the
 * whole change set at once, so a single CLI call covers every card and the
 * budget is shared: once it runs out the remaining files arrive with an empty
 * patch and `truncated` set, rather than one enormous payload.
 */
export function patchesFor(payload: unknown, maxChars: number): Patches {
  const files: FilePatch[] = [];
  let budget = maxChars;
  let truncated = false;

  for (const group of groupByPath(payload)) {
    if (group.hunks.length === 0) {
      files.push({ ...group.change, patch: "", truncated: false });
      continue;
    }
    const body = patchBody(group.hunks, budget);
    budget -= body.body.length;
    truncated ||= body.truncated;
    const header = patchHeader(group.change.path, group.previousPath, group.status);
    files.push({
      ...group.change,
      patch: body.body === "" ? "" : header + body.body,
      truncated: body.truncated,
    });
  }
  return { files, truncated };
}

/**
 * `git log` records, NUL-delimited so paths and subjects survive intact. git
 * terminates each formatted record with a newline of its own, so every record
 * after the first starts with one.
 */
export function parseGitLog(output: string): BaseCommit[] {
  const parsed: BaseCommit[] = [];
  for (const rawRecord of output.split("\0\0")) {
    const record = rawRecord.replace(/^\s+/, "");
    if (record === "") continue;
    const [commitId = "", authorName = "", createdAt = "", message = ""] = record.split("\0");
    if (commitId === "") continue;
    parsed.push({ commitId, authorName, createdAt, message });
  }
  return parsed;
}
