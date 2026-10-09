import type {
  BaseCommit,
  Branch,
  BranchReview,
  BranchStatus,
  ChangeKind,
  Commit,
  FileChange,
  FilePatch,
  HostWorkspace,
  OplogEntry,
  ParkedBranch,
  Patches,
  PushMode,
  Stack,
  Upstream,
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
  // `but status` calls a deletion `removed` where `but diff` says `deleted`.
  const kind = raw === "removed" ? "deleted" : raw;
  return { path, kind: CHANGE_KINDS.has(kind) ? (kind as ChangeKind) : "modified" };
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
    createdAt: asString(record?.["createdAt"]),
    conflicted: record?.["conflicted"] === true,
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
  // Local commits on top of the remote branch, which a plain push fast-forwards.
  unpushedCommits: "ahead",
  unpushedCommitsRequiringForce: "diverged",
  nothingToPush: "pushed",
  remoteAhead: "diverged",
  integrated: "integrated",
  fullyIntegrated: "integrated",
  conflicted: "conflicted",
  empty: "empty",
};

/** Which statuses have commits the remote lacks, and whether sending them rewrites it. */
const PUSH_MODE: Readonly<Record<string, PushMode>> = {
  completelyUnpushed: "push",
  unpushedCommits: "push",
  unpushedCommitsRequiringForce: "force",
};

/** The review's checks: still running, or the forge's verdict once they finish. */
function ciState(value: unknown): Branch["ci"] {
  const ci = asObject(value);
  if (!ci) return null;
  if (ci["status"] === "inProgress") return "pending";
  const conclusion = ci["conclusion"];
  return conclusion === "success" || conclusion === "failure" ? conclusion : null;
}

function branch(value: unknown): Branch | undefined {
  const record = asObject(value);
  const name = asString(record?.["name"]);
  if (name === "") return undefined;
  const rawStatus = asString(record?.["branchStatus"], "unknown");
  const branchCommits = commits(record?.["commits"]);
  const upstream = commits(record?.["upstreamCommits"]);
  return {
    name,
    status: BRANCH_STATUS[rawStatus] ?? "unknown",
    rawStatus,
    // An empty branch has a status too, but nothing a push would send.
    push: branchCommits.length > 0 ? (PUSH_MODE[rawStatus] ?? "none") : "none",
    // `but status` wraps the id in parentheses, as in "(#42)".
    reviewId: asNullableString(record?.["reviewId"])?.replace(/^\((.+)\)$/, "$1") ?? null,
    ci: ciState(record?.["ci"]),
    commits: branchCommits,
    upstreamCommits: upstream,
    // Until git compares the two sides (upstream.ts), every one counts as new.
    newUpstream: upstream.length,
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

/** When the stack last gained a commit, or -Infinity for a stack with none. */
function lastCommittedAt(stack: Stack): number {
  let latest = -Infinity;
  for (const branch of stack.branches) {
    for (const commit of branch.commits) {
      const time = Date.parse(commit.createdAt);
      if (time > latest) latest = time;
    }
  }
  return latest;
}

/**
 * `but` lists stacks in the order they were applied. The stack an agent just
 * committed to is the one worth reading, so the most recently committed one
 * leads and empty stacks trail. The sort is stable, so ties keep CLI order.
 */
function byLastCommit(stacks: Stack[]): Stack[] {
  const times = new Map(stacks.map((stack) => [stack, lastCommittedAt(stack)]));
  return stacks.sort((left, right) => {
    const a = times.get(left)!;
    const b = times.get(right)!;
    return a === b ? 0 : b > a ? 1 : -1;
  });
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

/** The first line of a commit message. */
function subjectOf(message: string): string {
  return message.split("\n", 1)[0]!.trim();
}

/** The target as GitButler last fetched it: how far ahead it is, and its newest commit. */
function upstream(value: unknown): Upstream | null {
  const record = asObject(value);
  if (!record) return null;
  const behind = typeof record["behind"] === "number" ? record["behind"] : 0;
  const latest = baseCommit(record["latestCommit"]);
  return {
    behind: Math.max(0, Math.trunc(behind)),
    lastFetched: asNullableString(record["lastFetched"]),
    latest: latest ? { commitId: latest.commitId, subject: subjectOf(latest.message) } : null,
  };
}

/**
 * `repositoryKey` is the repository the host resolved. Callers that only read
 * the stacks leave it out.
 */
export function parseWorkspace(
  payload: unknown,
  repoName: string,
  repositoryKey: string | null = null,
): HostWorkspace {
  const root = asObject(payload) ?? {};
  return {
    state: "ready",
    reason: null,
    repositoryKey,
    repoName,
    unassignedChanges: fileChanges(root["uncommittedChanges"]),
    stacks: byLastCommit(
      asArray(root["stacks"]).flatMap((entry) => {
        const parsed = stack(entry);
        return parsed ? [parsed] : [];
      }),
    ),
    base: baseCommit(root["mergeBase"]) ?? null,
    upstream: upstream(root["upstreamState"]),
    // Present only while some file holds conflict markers.
    conflictedFiles: asArray(root["conflictedFiles"]).flatMap((path) =>
      typeof path === "string" && path !== "" ? [path] : [],
    ),
  };
}

/** What `but pull --check` predicts a workspace update would do. */
export type PullCheck = {
  upToDate: boolean;
  /** Branches whose commits the update would leave conflicted. */
  conflicted: string[];
  /** Uncommitted changes overlap incoming commits, so files would get conflict markers. */
  overlapsUncommitted: boolean;
};

/**
 * Throws on a shape it does not know rather than guess: a guess of "no
 * conflicts" would run the update without asking.
 */
export function pullCheck(payload: unknown): PullCheck {
  const root = asObject(payload);
  const statuses = root?.["branchStatuses"];
  if (typeof root?.["upToDate"] !== "boolean" || !Array.isArray(statuses)) {
    throw new Error("GitButler's pull check answered in a shape this panel does not know.");
  }
  return {
    upToDate: root["upToDate"],
    conflicted: statuses.flatMap((entry) => {
      const status = asObject(entry);
      const name = asString(status?.["name"]);
      return status?.["status"] === "conflicted" && name !== "" ? [name] : [];
    }),
    overlapsUncommitted: root["hasWorktreeConflicts"] === true,
  };
}

/** The target branch's name and newest commit, as `but pull --check` just fetched them. */
export function checkedTarget(payload: unknown): { name: string; commitId: string } {
  const base = asObject(asObject(payload)?.["baseBranch"]);
  const name = asString(base?.["name"]);
  const commitId = asString(base?.["currentSha"]);
  if (name === "" || commitId === "") {
    throw new Error("GitButler's pull check answered in a shape this panel does not know.");
  }
  return { name, commitId };
}

/** What a `but branch update --dry-run` preview would do to the workspace. */
export type UpdatePreview = {
  /** Commits the update would take out of one branch and into another. */
  moved: { from: string; to: string }[];
  /** Branches the update would leave with newly conflicted commits. */
  conflicted: string[];
};

/**
 * Follows each of the workspace's commits into the preview, by commit id
 * through the preview's map of rewritten commits. A pull may only add
 * commits to the branch it pulls.
 *
 * `but` 0.22.3 can update the lower branch of a stack by taking the upper
 * branch's commits into it, and a plain push then publishes them under the
 * wrong name. Its preview shows the move, so the panel refuses before it
 * happens. A commit the preview no longer holds at all counts as moved too.
 * Throws on a preview shape it does not know, for the same reason as
 * `pullCheck`.
 */
export function judgeBranchUpdate(statusPayload: unknown, previewPayload: unknown): UpdatePreview {
  const { replaced, owner, conflictedIn } = previewCommits(previewPayload);
  const moved = new Map<string, { from: string; to: string }>();
  const commits = parseWorkspace(statusPayload, "").stacks.flatMap((stack) =>
    stack.branches.flatMap((branch) => branch.commits.map((commit) => ({ branch, commit }))),
  );
  for (const { branch, commit } of commits) {
    const now = asString(replaced[commit.commitId], commit.commitId);
    // Already conflicted before the update, so not news the reader must accept.
    if (commit.conflicted) conflictedIn.delete(now);
    const to = owner.get(now) ?? "";
    if (to !== branch.name) moved.set(`${branch.name}\0${to}`, { from: branch.name, to });
  }
  return { moved: [...moved.values()], conflicted: [...new Set(conflictedIn.values())] };
}

/** An update preview's rewritten commits, which branch holds each commit, and which conflict. */
function previewCommits(previewPayload: unknown): {
  replaced: Record<string, unknown>;
  owner: Map<string, string>;
  conflictedIn: Map<string, string>;
} {
  const workspace = asObject(asObject(previewPayload)?.["workspace"]);
  const replaced = asObject(workspace?.["replacedCommits"]);
  const stacks = asObject(workspace?.["headInfo"])?.["stacks"];
  if (!replaced || !Array.isArray(stacks)) {
    throw new Error("GitButler's update preview answered in a shape this panel does not know.");
  }
  const owner = new Map<string, string>();
  const conflictedIn = new Map<string, string>();
  const segments = stacks.flatMap((stack) => asArray(asObject(stack)?.["segments"]));
  for (const segment of segments.map(asObject)) {
    const name = asString(asObject(segment?.["refName"])?.["displayName"]);
    for (const commit of asArray(segment?.["commits"]).map(asObject)) {
      const id = asString(commit?.["id"]);
      if (id === "") continue;
      owner.set(id, name);
      if (commit?.["hasConflicts"] === true) conflictedIn.set(id, name);
    }
  }
  return { replaced, owner, conflictedIn };
}

/**
 * The workspace branch a write names, read from `but status -u --json`.
 * `but` resolves an argument as a CLI id too, and ids are short words like
 * `fi`, so a branch named like another item's id could send the write there.
 * Throws for a branch that left the workspace or whose name is such an id.
 */
export function namedBranch(statusPayload: unknown, name: string): Branch {
  const branch = parseWorkspace(statusPayload, "")
    .stacks.flatMap((stack) => stack.branches)
    .find((candidate) => candidate.name === name);
  if (branch === undefined) throw new Error(`${name} is no longer in the workspace.`);
  if (cliIdElsewhere(statusPayload, name)) {
    throw new Error(
      `GitButler also uses ${name} as the id of something else in this workspace, so \`but\` could act on that instead. Rename the branch in GitButler first.`,
    );
  }
  return branch;
}

/** Whether any item in the status, other than the branch called `name`, has `name` as its id. */
function cliIdElsewhere(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => cliIdElsewhere(entry, name));
  const record = asObject(value);
  if (!record) return false;
  if (record["cliId"] === name && record["name"] !== name) return true;
  return Object.values(record).some((entry) => cliIdElsewhere(entry, name));
}

/** `but branch show -r --json` to the web address of the branch's review. */
export function reviewUrl(payload: unknown): string | null {
  const [review] = asArray(asObject(payload)?.["reviews"]);
  return asNullableString(asObject(review)?.["url"]);
}

/** Milliseconds since the epoch, as `but branch list` and `but oplog` write times, in ISO form. */
function isoTime(value: unknown): string | null {
  if (typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `but branch list --json` heads: the workspace's, then every other local branch. */
function listedHeads(payload: unknown): { applied: Json[]; parked: Json[] } {
  const root = asObject(payload);
  const records = (entries: unknown[]) =>
    entries.flatMap((entry) => {
      const record = asObject(entry);
      return record ? [record] : [];
    });
  return {
    applied: records(
      asArray(root?.["appliedStacks"]).flatMap((stack) => asArray(asObject(stack)?.["heads"])),
    ),
    parked: records(asArray(root?.["branches"])),
  };
}

/**
 * `but branch list --review --json` to each branch's review. A record carries
 * only the number and address, and `but` keeps open reviews only, so a listed
 * review is open, or a draft where its record says so.
 */
export function parseReviews(payload: unknown): BranchReview[] {
  const { applied, parked } = listedHeads(payload);
  return [...applied, ...parked].flatMap((head): BranchReview[] => {
    const branch = asString(head["name"]);
    const review = asObject(asArray(head["reviews"])[0]);
    const number = review?.["number"];
    if (branch === "" || typeof number !== "number" || !Number.isInteger(number) || number < 0) {
      return [];
    }
    return [
      {
        branch,
        number,
        state: review?.["draft"] === true ? "draft" : "open",
        url: asNullableString(review?.["url"]),
      },
    ];
  });
}

/**
 * `but branch list --local --json` lists the workspace's branches under
 * `appliedStacks` and every other local branch under `branches`. The second
 * are the parked ones. `but` names no commit message, so `subject` is left
 * for git to fill in.
 */
export function parseParkedBranches(payload: unknown): {
  branches: ParkedBranch[];
  hasMore: boolean;
} {
  const { applied, parked } = listedHeads(payload);
  const inWorkspace = new Set(applied.map((head) => asString(head["name"])));
  return {
    branches: parked.flatMap((record) => {
      const name = asString(record["name"]);
      if (name === "" || inWorkspace.has(name)) return [];
      return [{ name, subject: null, updatedAt: isoTime(record["lastCommitAt"]) }];
    }),
    hasMore: asObject(payload)?.["hasMoreBranches"] === true,
  };
}

/**
 * `git for-each-ref` output whose format ends both fields, a branch's short
 * name and its subject, with a NUL. git adds a newline after each record.
 */
export function parseRefSubjects(output: string): Map<string, string> {
  const fields = output.split("\0");
  const subjects = new Map<string, string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index]!.replace(/^\n/, "");
    if (name !== "") subjects.set(name, fields[index + 1]!);
  }
  return subjects;
}

/** `but oplog list --json` to its entries, newest first as `but` lists them. */
export function parseOplog(payload: unknown): OplogEntry[] {
  return asArray(payload).flatMap((entry) => {
    const record = asObject(entry);
    const id = asString(record?.["id"]);
    if (id === "") return [];
    const details = asObject(record?.["details"]);
    const operation = asString(details?.["operation"], "Unknown");
    return [
      {
        id,
        operation,
        title: asString(details?.["title"], operation),
        body: asNullableString(details?.["body"]),
        createdAt: isoTime(record?.["createdAt"]) ?? "",
      },
    ];
  });
}

/**
 * Each uncommitted file's change kind. `but diff` calls every uncommitted file
 * modified, new and deleted ones included, so the kind comes from `but status`.
 */
export function uncommittedKinds(statusPayload: unknown): Map<string, ChangeKind> {
  const workspace = parseWorkspace(statusPayload, "");
  const changes = [
    ...workspace.unassignedChanges,
    ...workspace.stacks.flatMap((stack) => stack.assignedChanges),
  ];
  return new Map(changes.map((change) => [change.path, change.kind]));
}

const QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
};

/** git's escape for one character of a quoted path. */
function escapeChar(char: string): string {
  if (char === '"' || char === "\\") return `\\${char}`;
  const named = Object.entries(QUOTED_ESCAPES).find(([, value]) => value === char)?.[0];
  return named === undefined
    ? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`
    : `\\${named}`;
}

/**
 * A header path written the way git writes it: C-quoted when it holds a quote,
 * a backslash, or a control character. Bare, a newline in a file name would
 * end the header line and the rest of the name would read as patch lines.
 */
function quotePath(path: string): string {
  const special = (char: string) => char === '"' || char === "\\" || char < " " || char === "\x7f";
  if (![...path].some(special)) return path;
  return `"${[...path].map((char) => (special(char) ? escapeChar(char) : char)).join("")}"`;
}

/**
 * git's own header lines for one change. Pierre parses a real git patch, so
 * the hunk bodies `but diff --json` returns are not enough on their own: the
 * `diff --git` and `---`/`+++` lines are what name the file, and the filename
 * is what selects the syntax highlighter.
 */
function patchHeader(path: string, previousPath: string, kind: ChangeKind): string {
  const before = quotePath(`a/${previousPath}`);
  const after = quotePath(`b/${path}`);
  const lines = [`diff --git ${before} ${after}`];
  if (kind === "added") lines.push("new file mode 100644");
  else if (kind === "deleted") lines.push("deleted file mode 100644");
  else if (previousPath !== path) {
    lines.push(`rename from ${quotePath(previousPath)}`, `rename to ${quotePath(path)}`);
  }
  lines.push(
    kind === "added" ? "--- /dev/null" : `--- ${before}`,
    kind === "deleted" ? "+++ /dev/null" : `+++ ${after}`,
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
  /** Over `but`'s own size limit, so it sent no hunks at all. */
  tooLarge: boolean;
  hunks: string[];
};

/**
 * `but diff --json` emits one record per hunk, each carrying the change id
 * GitButler commits by, so a file with six edits arrives six times. The panel
 * shows files, not hunks, so they are folded back together here and re-sorted
 * into file order. `kinds` overrides the kind `but diff` reported.
 */
function groupByPath(payload: unknown, kinds?: ReadonlyMap<string, ChangeKind>): Grouped[] {
  const groups = new Map<string, Grouped>();
  for (const entry of asArray(asObject(payload)?.["changes"])) {
    const record = asObject(entry);
    const change = record && fileChange(record);
    if (!record || !change) continue;

    let group = groups.get(change.path);
    if (!group) {
      group = {
        change: { path: change.path, kind: kinds?.get(change.path) ?? change.kind },
        previousPath: asString(record["previousPath"] ?? record["oldPath"], change.path),
        tooLarge: false,
        hunks: [],
      };
      groups.set(change.path, group);
    }
    const diff = asObject(record["diff"]);
    // Binary files and files over the size limit carry no hunks.
    if (diff && asString(diff["type"]) !== "patch") {
      group.tooLarge ||= asString(diff["type"]) === "tooLarge";
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
 * A path as a patch header writes it. `core.quotePath=false` keeps non-ASCII
 * names bare, but a name with a quote, a backslash, or a control character is
 * still C-quoted, with octal escapes for the bytes of anything unprintable.
 */
function headerPath(text: string): string {
  if (!/^".*"$/s.test(text)) return text;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const [, octal, escaped, raw] of text
    .slice(1, -1)
    .matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gs)) {
    if (octal !== undefined) bytes.push(Number.parseInt(octal, 8));
    else
      bytes.push(
        ...encoder.encode(escaped === undefined ? raw : (QUOTED_ESCAPES[escaped] ?? escaped)),
      );
  }
  // A name may start with U+FEFF, which the default decoder drops as a BOM.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(bytes));
}

/** The path a `---`/`+++` line names, without its side prefix, or none for /dev/null. */
function sidePath(value: string | undefined, prefix: "a/" | "b/"): string | undefined {
  // git ends a path that contains a space with a tab.
  const path = value === undefined ? undefined : headerPath(value.replace(/\t$/, ""));
  return path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/**
 * The path of a `diff --git` line whose two sides are the same file, which is
 * every change but a rename, and a rename names itself on its own lines.
 */
function diffGitPath(line: string): string | undefined {
  const quoted = /^diff --git "(?:[^"\\]|\\.)*" ("(?:[^"\\]|\\.)*")$/.exec(line)?.[1];
  if (quoted !== undefined) return sidePath(quoted, "b/");
  return /^diff --git a\/(.+) b\/\1$/.exec(line)?.[1];
}

/** One file's `diff --git` block of `git show` output, or null for one it cannot name. */
function gitGroup(chunk: string): Grouped | null {
  const firstHunk = chunk.search(/^@@ /m);
  const header = (firstHunk === -1 ? chunk : chunk.slice(0, firstHunk)).split("\n");
  const field = (prefix: string) =>
    header.find((line) => line.startsWith(prefix))?.slice(prefix.length);
  const pathField = (prefix: string) => {
    const value = field(prefix);
    return value === undefined ? undefined : headerPath(value);
  };
  const previousPath = pathField("rename from ");
  const path =
    pathField("rename to ") ??
    sidePath(field("+++ "), "b/") ??
    // A deleted file's only path is its old one.
    sidePath(field("--- "), "a/") ??
    // A binary file has no ---/+++ lines at all.
    diffGitPath(header[0] ?? "");
  if (!path) return null;
  let kind: ChangeKind = previousPath === undefined ? "modified" : "renamed";
  if (field("new file mode") !== undefined) kind = "added";
  if (field("deleted file mode") !== undefined) kind = "deleted";
  return {
    change: { path, kind },
    previousPath: previousPath ?? path,
    tooLarge: false,
    hunks: firstHunk === -1 ? [] : chunk.slice(firstHunk).split(/^(?=@@ )/m),
  };
}

/**
 * `git show` output to the same groups. Git already writes a patch per file,
 * but regrouping it keeps the header, the kind, and the budget in one place
 * for both sources.
 */
function groupGitPatch(output: string): Grouped[] {
  const groups = new Map<string, Grouped>();
  for (const chunk of output.split(/^(?=diff --git )/m)) {
    const group = gitGroup(chunk);
    if (!group) continue;
    const earlier = groups.get(group.change.path);
    if (!earlier) {
      groups.set(group.change.path, group);
      continue;
    }
    /*
     * A file that became a symlink, or the reverse, is written as a deletion
     * and an addition of the same path. The panel has one card per path, so
     * the two fold into one change that shows the side that exists now.
     */
    earlier.change = { path: earlier.change.path, kind: "modified" };
    if (group.change.kind !== "deleted") earlier.hunks = group.hunks;
  }
  return [...groups.values()];
}

/**
 * One complete git patch per file. The panel renders the whole change set at
 * once, so a single call covers every card and the budget is shared: once it
 * runs out the remaining files arrive with an empty patch and `truncated` set,
 * rather than one enormous payload.
 */
function patchesOf(groups: readonly Grouped[], maxChars: number): Patches {
  const files: FilePatch[] = [];
  let budget = maxChars;
  let truncated = false;

  for (const group of groups) {
    const previousPath = group.previousPath === group.change.path ? null : group.previousPath;
    if (group.hunks.length === 0) {
      truncated ||= group.tooLarge;
      files.push({ ...group.change, previousPath, patch: "", truncated: group.tooLarge });
      continue;
    }
    const body = patchBody(group.hunks, budget);
    budget -= body.body.length;
    truncated ||= body.truncated;
    const header = patchHeader(group.change.path, group.previousPath, group.change.kind);
    files.push({
      ...group.change,
      previousPath,
      patch: body.body === "" ? "" : header + body.body,
      truncated: body.truncated,
    });
  }
  return { files, truncated };
}

/** `but diff --json` to patches. `kinds` corrects what it reports for uncommitted files. */
export function patchesFor(
  payload: unknown,
  maxChars: number,
  kinds?: ReadonlyMap<string, ChangeKind>,
): Patches {
  return patchesOf(groupByPath(payload, kinds), maxChars);
}

/** `git show` to patches, for a commit `but diff` cannot resolve. */
export function patchesFromGit(output: string, maxChars: number): Patches {
  return patchesOf(groupGitPatch(output), maxChars);
}

/**
 * `git log -z` records: four NUL-terminated fields each, so a subject with any
 * printable character, or none at all, cannot shift the fields after it.
 */
export function parseGitLog(output: string): BaseCommit[] {
  const parsed: BaseCommit[] = [];
  const fields = output.split("\0");
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [commitId = "", authorName = "", createdAt = "", message = ""] = fields.slice(
      index,
      index + 4,
    );
    // `%B` ends the message with a newline the workspace's messages do not have.
    if (commitId !== "")
      parsed.push({ commitId, authorName, createdAt, message: message.trimEnd() });
  }
  return parsed;
}
