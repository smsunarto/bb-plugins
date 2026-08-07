// bb-plugin-gh-stack — stacked-PR visibility and actions for BB threads.
//
// Runs `gh stack` commands in a thread's workspace (server host):
// view --json for the panel, plus sync / submit / init actions.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  buildChangeSet,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainZ,
  parseWcLines,
  type ChangeSet,
  type DiffCounts,
} from "./lib/git-diff";

const prSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string(),
});

const branchSchema = z.object({
  name: z.string(),
  isCurrent: z.boolean().catch(false),
  isMerged: z.boolean().catch(false),
  isQueued: z.boolean().catch(false),
  needsRebase: z.boolean().catch(false),
  // Absent when the branch has no PR yet — normalize to null for the wire.
  pr: prSchema
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
});

const stackSchema = z.object({
  trunk: z.string(),
  currentBranch: z
    .string()
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  // Ordered bottom (nearest trunk) to top.
  branches: z.array(branchSchema),
});

// Wire shape after enriching each PR with title/isDraft from `gh pr view`
// (gh stack view --json exposes neither).
const prOutSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string(),
  title: z.string().nullable(),
  isDraft: z.boolean(),
});

// Changed-file info computed with git in the workspace. Counts are null when
// unknown (binary files, untracked files past the counting cap).
const diffFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "deleted", "modified", "renamed", "untracked"]),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
});

const changeSetSchema = z.object({
  additions: z.number(),
  deletions: z.number(),
  files: z.array(diffFileSchema),
  truncated: z.boolean(),
});

const branchOutSchema = z.object({
  name: z.string(),
  isCurrent: z.boolean(),
  isMerged: z.boolean(),
  isQueued: z.boolean(),
  needsRebase: z.boolean(),
  pr: prOutSchema.nullable(),
  // Diff against the branch's stack parent (the branch below, or the trunk).
  diff: changeSetSchema.nullable(),
  // Commits on the local branch that origin/<name> lacks — what a push would
  // send. Null when there is no remote branch or the probe failed.
  aheadOfRemote: z.number().nullable(),
  // Commits on origin/<name> that the local branch lacks — the remote moved
  // under it (a push from elsewhere, or divergence). 0 when there is no
  // remote branch (nothing to be behind); null when the probe failed.
  behindRemote: z.number().nullable(),
});

const stackOutSchema = z.object({
  trunk: z.string(),
  currentBranch: z.string().nullable(),
  branches: z.array(branchOutSchema),
  // Commits on origin/<trunk> that the local trunk lacks, as of the last
  // fetch — "the trunk moved". Null when the probe failed.
  trunkBehind: z.number().nullable(),
});

const prEnrichSchema = z.object({
  title: z.string().catch(""),
  isDraft: z.boolean().catch(false),
});

const errorKindSchema = z.enum([
  "no-environment",
  "workspace-missing",
  "gh-missing",
  "not-a-stack",
  "api-failure",
  "stack-locked",
  "stacks-unavailable",
  "rebase-conflict",
  "sync-aborted",
  "timeout",
  "other",
]);

const workspaceErrorSchema = z.object({
  kind: errorKindSchema,
  message: z.string(),
});

export type StackView = z.infer<typeof stackSchema>;
export type StackErrorKind = z.infer<typeof errorKindSchema>;
type StackPayload = z.infer<typeof stackPayloadSchema>;

const actionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  // Tail of combined command output, for diagnostics in the panel.
  detail: z.string().nullable(),
});

// The namespace new stacks land in until the gear popup says otherwise.
const DEFAULT_BRANCH_PREFIX = "bb/";

// Panel settings, edited in the gear popup and stored in the plugin's kv.
// Both are lenient on read so a row written by an older build still loads.
const settingsSchema = z.object({
  // Namespace put in front of every derived branch ("bb/"). Empty means
  // "match the branches already in the workspace" (the detected prefix).
  // Stored with or without its trailing separator; every join adds one.
  branchPrefix: z.string().catch(DEFAULT_BRANCH_PREFIX),
  // Layer names read as Conventional Commits ("feat(api): add rate limiting"),
  // and the derived branch carries the type and the scope
  // ("bb/feat-api-add-rate-limiting").
  conventionalCommits: z.boolean().catch(true),
});

export type Settings = z.infer<typeof settingsSchema>;

const DEFAULT_SETTINGS: Settings = {
  branchPrefix: DEFAULT_BRANCH_PREFIX,
  conventionalCommits: true,
};

const settingsResultSchema = z.object({
  ok: z.boolean(),
  // Why a save was rejected; null when it succeeded.
  message: z.string().nullable(),
  // Always the values now in force, so the panel can adopt them as-is.
  settings: settingsSchema,
});

// A new layer: the PR-title-like name, plus the exact branch the panel
// previewed (prefix included). Without `branch` the name is slugified here.
const layerInputSchema = z
  .object({
    threadId: z.string(),
    name: z.string(),
    branch: z.string().optional(),
  })
  .strict();

// Everything getStack computes for one thread — also the unit the server
// caches per thread (fetchedAt is added at the wire).
const stackPayloadSchema = z.object({
  stack: stackOutSchema.nullable(),
  workspacePath: z.string().nullable(),
  error: workspaceErrorSchema.nullable(),
  // Uncommitted working-tree changes — what would carry onto a newly
  // stacked branch. Present whenever the workspace resolves, including
  // the not-a-stack case (it feeds the create form too).
  pending: changeSetSchema.nullable(),
  // The repository's default branch, so the rail can name its base
  // before a stack exists (a stack reports its own trunk).
  defaultBranch: z.string().nullable(),
  // Namespace a proposed branch gets: the configured prefix when the
  // settings popup sets one, else the namespace the workspace's branches
  // already share ("bb/"), so a new branch reads like the existing ones.
  branchPrefix: z.string().nullable(),
  // Only the detected half of the above, so the settings popup can offer it
  // as the placeholder for an empty prefix field.
  detectedBranchPrefix: z.string().nullable(),
  // The settings in force, as stored — branchPrefix here is the raw
  // configured value ("" when unset), not the effective one above.
  settings: settingsSchema,
  // The number GitHub would most likely give the next pull request —
  // one past the highest issue or PR number. A guess: concurrent work
  // in the repository can take it first.
  nextPrNumber: z.number().nullable(),
});

// How the stack merge lands each PR. Squash is the default: one commit per
// branch in the base, which is the shape a stack is written for.
const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]);

export type MergeMethod = z.infer<typeof mergeMethodSchema>;

export const rpcContract = defineRpcContract({
  // Stale-while-revalidate: without `refresh` a cached payload is returned
  // immediately and, when stale, recomputed in the background — the fresh
  // result is announced on the "stack-updated" realtime channel. With
  // `refresh: true` the call waits for a fresh compute.
  getStack: {
    input: z
      .object({ threadId: z.string(), refresh: z.boolean().optional() })
      .strict(),
    output: stackPayloadSchema.extend({
      // Epoch ms of the compute that produced this payload.
      fetchedAt: z.number(),
    }),
  },
  setPrDraft: {
    input: z
      .object({
        threadId: z.string(),
        prNumber: z.number().int().positive(),
        draft: z.boolean(),
      })
      .strict(),
    output: actionResultSchema,
  },
  // Check out a stack branch in the thread's workspace. The branch must be
  // one the stack payload knows, so the panel cannot check out an arbitrary
  // ref.
  checkoutBranch: {
    input: z.object({ threadId: z.string(), branch: z.string() }).strict(),
    output: actionResultSchema,
  },
  runAction: {
    input: z
      .object({
        threadId: z.string(),
        // sync-submit: sync first, then submit — the panel sends it when the
        // stack needs a restack, so submit never pushes branches that are
        // about to be rebased. prune: sync --prune, deleting local branches
        // whose PRs merged.
        action: z.enum(["sync", "submit", "sync-submit", "prune"]),
      })
      .strict(),
    output: actionResultSchema,
  },
  // Merge the stack bottom-first through GitHub's atomic stack-merge API.
  // The set is the run of unmerged PRs from the trunk up that GitHub would
  // accept, which need not be the whole stack — `throughPrNumber` is the PR
  // the panel offered to stop at.
  mergeStack: {
    input: z
      .object({
        threadId: z.string(),
        method: mergeMethodSchema.default("squash"),
        throughPrNumber: z.number().int().positive().optional(),
      })
      .strict(),
    output: actionResultSchema,
  },
  createStack: {
    input: layerInputSchema,
    output: actionResultSchema,
  },
  // Stack a new branch on top of the existing stack: gh stack top + add.
  addBranch: {
    input: layerInputSchema,
    output: actionResultSchema,
  },
  suggestStackName: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ name: z.string() }),
  },
  autoStack: {
    input: z.object({ threadId: z.string() }).strict(),
    output: actionResultSchema,
  },
  saveSettings: {
    input: z
      .object({
        // Normalized server-side; rejected there when it cannot be a git ref.
        branchPrefix: z.string().max(60),
        conventionalCommits: z.boolean(),
      })
      .strict(),
    output: settingsResultSchema,
  },
});

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
  failedToSpawn: boolean;
  timedOut: boolean;
}

function runCmd(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          stdout,
          stderr,
          failedToSpawn: err?.code === "ENOENT",
          timedOut: err?.killed === true,
        });
      },
    );
  });
}

function runGh(args: string[], cwd: string, timeoutMs: number): Promise<GhResult> {
  return runCmd("gh", args, cwd, timeoutMs);
}

function runGit(args: string[], cwd: string, timeoutMs = 15_000): Promise<GhResult> {
  return runCmd("git", args, cwd, timeoutMs);
}

function outputTail(result: GhResult, maxChars = 2000): string | null {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (!combined) return null;
  return combined.length > maxChars ? `…${combined.slice(-maxChars)}` : combined;
}

// Smart-checkout bookkeeping: a stash this plugin creates is tagged with the
// branch whose changes it holds, so checking that branch out again restores
// it. The prefix is what popAutoStash matches on — hand-made stashes are
// never touched.
const AUTO_STASH_PREFIX = "gh-stack auto-stash: ";

type AutoStashOutcome = "none" | "restored" | "conflict";

async function popAutoStash(cwd: string, branch: string): Promise<AutoStashOutcome> {
  const list = await runGit(["stash", "list", "--format=%gd%x09%gs"], cwd);
  if (list.code !== 0) return "none";
  const needle = `${AUTO_STASH_PREFIX}${branch}`;
  // Most recent first, which is also how balanced leave/return pairs nest.
  const entry = list.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find((columns) => columns.length === 2 && columns[1].endsWith(needle));
  if (!entry) return "none";
  const pop = await runGit(["stash", "pop", entry[0]], cwd, 30_000);
  // On conflict git applies what it can, leaves markers, and keeps the
  // stash entry — nothing is lost.
  return pop.code === 0 ? "restored" : "conflict";
}

// gh stack exit codes (see the gh-stack skill): 2 = not in a stack,
// 3 = rebase conflict, 4 = GitHub API failure, 8 = stack file locked,
// 9 = stacked PRs unavailable.
function mapExitCode(result: GhResult): { kind: StackErrorKind; message: string } {
  const detail = result.stderr.trim().split("\n").pop() ?? "";
  if (result.failedToSpawn) {
    return {
      kind: "gh-missing",
      message:
        "The gh CLI was not found on the BB server host. Install it and the gh-stack extension: gh extension install github/gh-stack.",
    };
  }
  if (result.timedOut) {
    return { kind: "timeout", message: "The gh stack command timed out." };
  }
  switch (result.code) {
    case 2:
      return {
        kind: "not-a-stack",
        message:
          "This workspace's branch is not part of a stack. Create one below or run gh stack init <branch>.",
      };
    case 3:
      return {
        kind: "rebase-conflict",
        message:
          "Rebase conflict. Run Sync to hand the recovery to this thread's agent, or resolve manually: gh stack rebase, fix the conflicts, then gh stack rebase --continue.",
      };
    case 4:
      return {
        kind: "api-failure",
        message: `GitHub API failure. Check gh auth status. ${detail}`.trim(),
      };
    case 8:
      return {
        kind: "stack-locked",
        message: "Another gh stack process holds the stack file lock. Retry in a few seconds.",
      };
    case 9:
      return {
        kind: "stacks-unavailable",
        message: "Stacked pull requests are not enabled on this repository.",
      };
    default:
      return {
        kind: "other",
        message: detail || `gh stack exited with code ${result.code}.`,
      };
  }
}

// Merging goes through GitHub's async stack-merge REST API rather than
// `gh stack merge`. The CLI is only a wrapper over this API (gh-stack v0.1.0,
// internal/github/merge_async.go), and calling it directly is strictly
// better here:
//   * it is addressed by PULL REQUEST number in the path, so nothing ever
//     resolves the number — `gh stack merge <n>` reads a bare number as a
//     stack number first and offers no way to force the PR reading;
//   * the merge is atomic server-side — the named PR and every unmerged PR
//     below it in the stack land together or not at all, exactly the
//     contract the CLI provides;
//   * a merge queue comes back as an explicit "enqueued" status instead of
//     prose to sniff out of CLI output;
//   * `gh api` prints non-2xx bodies, so the 400's reason and the 409's
//     existing merge-request uuid survive — the CLI's own client drops both.
// Flow (docs/reference/merge-api.md): PUT returns 202 {status:"pending",
// details.uuid} to poll, or resolves immediately (200 merged / 409 an
// existing request / 400 failed / 404 unavailable). GET .../{uuid} until
// status leaves "pending"; "merged", "enqueued", and "failed" are terminal.
const asyncMergeDetailsSchema = z.object({
  message: z.string().catch(""),
  uuid: z.string().optional().catch(undefined),
  sha: z.string().optional().catch(undefined),
});

const asyncMergeResultSchema = z.object({
  status: z.enum(["pending", "merged", "enqueued", "failed"]),
  details: asyncMergeDetailsSchema.catch({ message: "" }),
});

type AsyncMergeResult = z.infer<typeof asyncMergeResultSchema>;

function parseAsyncMergeBody(stdout: string): AsyncMergeResult | null {
  try {
    const parsed = asyncMergeResultSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The uuid is interpolated into an API path; GitHub issues RFC-4122 uuids,
// so anything else is rejected rather than trusted.
const MERGE_UUID = /^[0-9a-fA-F-]{8,64}$/;

const MERGE_POLL_INTERVAL_MS = 2_000;
const MERGE_POLL_DEADLINE_MS = 240_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Line counts for untracked files are one `wc -l` call; cap it so a huge
// untracked tree cannot blow up the command line.
const MAX_UNTRACKED_COUNTS = 50;

// The remote's default branch ("origin/main" → "main"), used as the rail's
// base label when the branch is not in a stack yet.
async function defaultBranchName(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
  if (result.code !== 0) return null;
  const name = result.stdout.trim().replace(/^origin\//, "");
  return name || null;
}

// Branch namespace ("bb/") the workspace already uses: the one every
// stack branch shares, else the current branch's own. Returns null when
// branches are unprefixed.
function branchPrefixOf(names: string[]): string | null {
  const prefixes = names.map((name) => {
    const slash = name.indexOf("/");
    return slash > 0 ? name.slice(0, slash + 1) : null;
  });
  const first = prefixes[0];
  if (!first) return null;
  return prefixes.every((prefix) => prefix === first) ? first : null;
}

async function currentBranchPrefix(cwd: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
  if (result.code !== 0) return null;
  return branchPrefixOf([result.stdout.trim()].filter(Boolean));
}

// GitHub numbers issues and pull requests from one sequence, so the newest
// of either, plus one, is the next PR number. A guess — someone else's PR
// can take it first.
async function nextPrNumber(cwd: string): Promise<number | null> {
  const result = await runGh(
    [
      "api",
      "repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc&per_page=1",
      "--jq",
      ".[0].number",
    ],
    cwd,
    20_000,
  );
  if (result.code !== 0) return null;
  const text = result.stdout.trim();
  if (!text) return 1; // no issues or PRs yet
  const latest = Number(text);
  return Number.isInteger(latest) && latest >= 0 ? latest + 1 : null;
}

// The trunkBehind / aheadOfRemote probes read remote-tracking refs, and the
// panel gates behavior on them (Submit escalates to sync-first) — so they
// must not present week-old refs as live truth. Fetch before probing, but
// only when the last fetch is older than this; a failed or slow fetch is
// tolerated (the probes then read the refs as they are).
const FETCH_MAX_AGE_MS = 90_000;

async function freshenRemoteRefs(cwd: string): Promise<void> {
  const gitDir = await runGit(["rev-parse", "--git-dir"], cwd);
  if (gitDir.code !== 0) return;
  const dir = gitDir.stdout.trim();
  const fetchHead = join(isAbsolute(dir) ? dir : join(cwd, dir), "FETCH_HEAD");
  try {
    if (Date.now() - statSync(fetchHead).mtimeMs < FETCH_MAX_AGE_MS) return;
  } catch {
    // no FETCH_HEAD yet — fetch below
  }
  await runGit(["fetch", "--quiet", "origin"], cwd, 20_000);
}

// Commits `right` has that `left` lacks, as of the last fetch. Null when
// either ref is missing (e.g. a branch never pushed) or the probe failed.
async function revListCount(
  cwd: string,
  left: string,
  right: string,
): Promise<number | null> {
  if (left.startsWith("-") || right.startsWith("-")) return null;
  const result = await runGit(["rev-list", "--count", `${left}..${right}`, "--"], cwd);
  if (result.code !== 0) return null;
  const count = Number(result.stdout.trim());
  return Number.isInteger(count) && count >= 0 ? count : null;
}

// Committed changes a branch introduces over its stack parent
// (merge-base three-dot range, so a pending rebase doesn't inflate it).
async function branchChangeSet(
  cwd: string,
  parent: string,
  branch: string,
): Promise<ChangeSet | null> {
  if (parent.startsWith("-") || branch.startsWith("-")) return null;
  const range = `${parent}...${branch}`;
  const [numstat, nameStatus] = await Promise.all([
    runGit(["diff", "--numstat", "-z", range, "--"], cwd),
    runGit(["diff", "--name-status", "-z", range, "--"], cwd),
  ]);
  if (numstat.code !== 0 || nameStatus.code !== 0) return null;
  return buildChangeSet(
    parseNameStatusZ(nameStatus.stdout),
    parseNumstatZ(numstat.stdout),
  );
}

// Uncommitted working-tree changes (staged + unstaged + untracked) — these
// carry onto a newly stacked branch. Untracked files get a wc -l line count,
// capped; past the cap their counts stay null.
async function pendingChangeSet(cwd: string): Promise<ChangeSet | null> {
  const status = await runGit(["status", "--porcelain=v1", "-z", "-uall"], cwd);
  if (status.code !== 0) return null;
  const entries = parsePorcelainZ(status.stdout);
  if (entries.length === 0) {
    return { additions: 0, deletions: 0, files: [], truncated: false };
  }
  const numstat = await runGit(["diff", "--numstat", "-z", "HEAD", "--"], cwd);
  const counts =
    numstat.code === 0 ? parseNumstatZ(numstat.stdout) : new Map<string, DiffCounts>();
  const untracked = entries
    .filter((entry) => entry.status === "untracked")
    .slice(0, MAX_UNTRACKED_COUNTS);
  if (untracked.length > 0) {
    // "./" prefix keeps a leading-dash path from reading as a wc flag.
    const wc = await runCmd(
      "wc",
      ["-l", ...untracked.map((entry) => `./${entry.path}`)],
      cwd,
      15_000,
    );
    for (const [path, lines] of parseWcLines(wc.stdout)) {
      counts.set(path, { additions: lines, deletions: 0 });
    }
  }
  return buildChangeSet(entries, counts);
}

// Branch names: conservative git-ref subset, no leading dash so it can never
// read as a flag.
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const STOPWORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// The Conventional Commits head of a title: "feat(api)!: add rate limiting"
// → type "feat", scope "api", subject "add rate limiting". The breaking "!"
// is dropped — it belongs in the title, not in a branch name.
const CONVENTIONAL_HEAD = /^\s*([A-Za-z]+)\s*(?:\(([^)]*)\))?\s*!?\s*:\s*(.+)$/;

function splitConventional(
  name: string,
): { type: string | null; scope: string | null; subject: string } {
  const match = CONVENTIONAL_HEAD.exec(name);
  if (!match) return { type: null, scope: null, subject: name };
  return {
    type: match[1].toLowerCase(),
    scope: match[2] ? match[2].toLowerCase() : null,
    subject: match[3],
  };
}

// The stack name is PR-title-like ("Add rate limiting to the API"); the
// branch is a short slug derived from it. Under Conventional Commits the
// name reads "feat(api): add rate limiting" and both the type and the scope
// lead the slug ("feat-api-add-rate-limiting"); a name without a type just
// slugifies. The scope is carried because it is often the only thing telling
// two layers of one stack apart — "add the plugin" says nothing on its own.
// Keep in sync with deriveBranchName in app.tsx (live preview).
function deriveBranchName(name: string, conventional: boolean): string {
  if (!conventional) return slugify(name);
  const { type, scope, subject } = splitConventional(name);
  const slug = slugify(subject);
  if (!slug) return "";
  if (!type) return slug;
  const scopeSlug = scope ? slugify(scope) : "";
  return scopeSlug ? `${type}-${scopeSlug}-${slug}` : `${type}-${slug}`;
}

// A prefix is a branch namespace, so it ends on a separator: "bb" and "bb/"
// name the same one. Applied at every join rather than trusted from the
// stored value, so a prefix typed or written without one still reads as a
// namespace instead of running into the slug ("bbfeat-…").
function withBranchSeparator(prefix: string): string {
  if (!prefix) return "";
  return /[/_-]$/.test(prefix) ? prefix : `${prefix}/`;
}

// The namespace a new branch actually gets: the configured prefix when the
// settings popup sets one, else whatever the workspace's branches share.
// Null when neither exists — the branch is then unprefixed.
function effectiveBranchPrefix(
  settings: Settings,
  detected: string | null,
): string | null {
  const prefix = withBranchSeparator(settings.branchPrefix) || detected;
  return prefix || null;
}

// A configured prefix must also be a legal ref head. Empty means "detect it".
function normalizeBranchPrefix(raw: string): { prefix: string } | { error: string } {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (!trimmed) return { prefix: "" };
  if (!BRANCH_NAME.test(trimmed)) {
    return {
      error:
        "A branch prefix must start with a letter or digit and use only letters, digits, and . _ - /",
    };
  }
  return { prefix: withBranchSeparator(trimmed) };
}

function humanizeBranch(branch: string): string {
  const words = branch.replace(/[-_/]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

// Auto Stack and the naming helper are agent runs the panel fires off. On
// the Claude Code harness, pin them to opus at medium reasoning so their
// quality does not ride on whatever model the thread happens to be set to;
// other harnesses keep their own defaults.
function agentRunOverrides(
  providerId: string,
): { model: string; reasoningLevel: "medium" } | Record<never, never> {
  return providerId === "claude-code"
    ? { model: "opus", reasoningLevel: "medium" }
    : {};
}

function suggestNamePrompt(conventional: boolean): string {
  return [
    "Inspect the current work in this workspace: uncommitted changes (git status, git diff) and commits not yet on the default branch.",
    conventional
      ? "Then reply with ONLY one Conventional Commits title that describes the work as a whole — `type(scope): subject`, type one of feat, fix, docs, refactor, perf, test, build, ci, chore; scope the package, module, or directory the work lives in, in brackets, omitted only when the change is repository-wide; subject in imperative mood, lower case, no trailing period; at most 60 characters in total."
      : "Then reply with ONLY one PR-style title that describes the work as a whole — imperative mood, at most 60 characters, no quotes, no trailing period.",
    "Your entire final message must be just the title, nothing else.",
  ].join("\n");
}

function sanitizeTitle(text: string): string {
  // The last non-empty line wins. `findLast` would say this directly, but the
  // plugins target ES2022, so index the filtered list instead.
  const lines = text
    .trim()
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1] ?? "";
  return line.replace(/^["'`]+|["'`.]+$/g, "").slice(0, 72);
}

// The panel's settings, restated for the agent so an Auto Stack run names
// branches and writes commits the way the composer would. Empty when nothing
// is configured and the agent should follow the repository's own habits.
function conventionsLines(settings: Settings, detectedPrefix: string | null): string[] {
  const lines: string[] = [];
  const prefix = effectiveBranchPrefix(settings, detectedPrefix);
  if (prefix) {
    lines.push(`Name every branch \`${prefix}<slug>\`, matching the prefix this workspace already uses.`);
  }
  if (settings.conventionalCommits) {
    lines.push(
      "Write every commit message and PR title as a Conventional Commit (`type(scope): subject`, type one of feat, fix, docs, refactor, perf, test, build, ci, chore). Put the package, module, or directory the layer touches in the brackets, and drop the brackets only when the layer is genuinely repository-wide. Do not repeat the scope in the subject — `feat(theme): add the plugin`, not `feat(theme): add the theme plugin`. Lead each branch slug with the same type and scope (e.g. `feat-api-add-rate-limiting`).",
    );
  }
  return lines;
}

function autoCreatePrompt(settings: Settings, detectedPrefix: string | null): string {
  return [
    "Split the work in this workspace into a stack of reviewable branches with `gh stack` (follow the gh-stack skill).",
    "1. Inspect the state: uncommitted changes plus commits not on the trunk branch.",
    "2. Design the layers bottom-to-top — one dependent concern per layer, foundational work at the bottom (read references/stack-design.md if unsure).",
    "3. Create the stack with `gh stack init <branch>` and `gh stack add <branch>`, moving each concern into its owning layer. Give every layer exactly ONE commit whose subject is the PR title you want — `submit --auto` uses the commit subject as the title only for single-commit branches; with more commits it falls back to humanizing the branch name, which makes a bad title.",
    "4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json`. If any layer ended up with multiple commits, fix its title now with `gh pr edit <number> --title \"...\"`. Verify every PR title reads like a sentence, not like a branch name, then share the PR links.",
    ...conventionsLines(settings, detectedPrefix),
    "If the work is a single indivisible concern, say so and create a one-layer stack instead of forcing a split.",
  ].join("\n");
}

// Same idea on a workspace that already has a stack: extend it rather than
// init a new one.
function autoExtendPrompt(settings: Settings, detectedPrefix: string | null): string {
  return [
    "This workspace already has a stack. Split the work that is not yet in it into more layers on top, with `gh stack` (follow the gh-stack skill).",
    "1. Inspect the state: `gh stack view --json`, plus uncommitted changes and commits not yet in a layer.",
    "2. Design the new layers bottom-to-top — one dependent concern per layer (read references/stack-design.md if unsure).",
    "3. Run `gh stack top`, then `gh stack add <branch>` per layer, moving each concern into its owning layer. Do not run `gh stack init`; it would start a second stack. Give every new layer exactly ONE commit whose subject is the PR title you want — `submit --auto` uses the commit subject as the title only for single-commit branches; with more commits it falls back to humanizing the branch name, which makes a bad title.",
    "4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json`. If any layer ended up with multiple commits, fix its title now with `gh pr edit <number> --title \"...\"`. Verify every PR title reads like a sentence, not like a branch name, then share the PR links.",
    ...conventionsLines(settings, detectedPrefix),
    "If the remaining work belongs in an existing layer, say so and commit it there instead of forcing a new layer.",
  ].join("\n");
}

// Cached stacks stay served without hitting gh for this long; older entries
// are still served instantly but trigger a background recompute.
const STACK_FRESH_MS = 10_000;
// A thread counts as watched while its cache was read this recently (open
// panels poll well inside this window); only watched threads get the
// idle-event refresh, so closed panels stop costing gh calls.
const STACK_WATCH_MS = 90_000;
// Idle events under this age of the cache don't recompute (burst coalescing).
const STACK_IDLE_COALESCE_MS = 2_000;

// How long an accepted draft⇄ready toggle keeps overriding what GitHub
// reports. `gh pr ready` returns once the write is accepted, but a `gh pr
// view` seconds later can still answer with the old value, so a payload
// computed in that window would repaint the pill it just flipped. Generous
// enough to cover that lag, short enough that a value nobody ever confirms
// cannot outlive the panel session.
const DRAFT_INTENT_TTL_MS = 120_000;

export default async function plugin(bb: BbPluginApi) {
  // Per-thread cache of the last computed getStack payload; lastReadAt is the
  // watched-thread signal for the idle-event refresh.
  const stackCache = new Map<
    string,
    { payload: StackPayload; fetchedAt: number; lastReadAt: number }
  >();
  // One compute per thread at a time: concurrent callers share the promise.
  const stackInflight = new Map<string, Promise<StackPayload>>();
  // When a non-trivial sync failure was last handed to a thread's agent. The
  // stack stays dirty while the agent works, so the buttons re-arm — this
  // keeps a second click from queueing a duplicate recovery prompt onto the
  // still-running agent. Cleared by any action that completes cleanly.
  const syncHandoffAt = new Map<string, number>();

  // Accepted-but-not-yet-visible draft toggles, by PR number: the value the
  // user asked for, and when. The cache keeps what GitHub actually reported;
  // this overlay is laid over it wherever a payload is served, so a pill that
  // flipped stays flipped through the window where `gh pr view` still answers
  // with the old value. An entry retires the moment a payload agrees with it
  // (the write is visible, the overlay is redundant) and a toggle whose
  // command failed deletes its own entry, so the pill snaps back to the truth
  // rather than lying about a change that never happened.
  const draftIntents = new Map<number, { draft: boolean; at: number }>();

  function applyDraftIntents(payload: StackPayload): StackPayload {
    const stack = payload.stack;
    if (!stack || draftIntents.size === 0) return payload;
    const now = Date.now();
    let overridden = false;
    const branches = stack.branches.map((branch) => {
      const pr = branch.pr;
      const intent = pr ? draftIntents.get(pr.number) : undefined;
      if (!pr || !intent) return branch;
      if (pr.isDraft === intent.draft || now - intent.at > DRAFT_INTENT_TTL_MS) {
        draftIntents.delete(pr.number);
        return branch;
      }
      overridden = true;
      return { ...branch, pr: { ...pr, isDraft: intent.draft } };
    });
    return overridden ? { ...payload, stack: { ...stack, branches } } : payload;
  }

  // Announce the current cache entry without recomputing it — how a toggle
  // reaches every open panel at once. Panels refetch, and the refetch runs
  // through the overlay above.
  function republish(threadId: string): void {
    const entry = stackCache.get(threadId);
    if (entry) {
      bb.realtime.publish("stack-updated", {
        threadId,
        fetchedAt: entry.fetchedAt,
      });
    }
  }

  // The settings popup writes one global kv row; it is read on every compute,
  // so keep the parsed value in memory and refresh it on save.
  const SETTINGS_KEY = "settings";
  let settingsCache: Settings | null = null;

  async function loadSettings(): Promise<Settings> {
    if (settingsCache) return settingsCache;
    const parsed = settingsSchema.safeParse(
      await bb.storage.kv.get<unknown>(SETTINGS_KEY),
    );
    settingsCache = parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
    return settingsCache;
  }

  // The branch the panel would have previewed for this layer name — same
  // rule, including the fall back to the workspace's own namespace when no
  // prefix is configured.
  async function deriveWithSettings(
    threadId: string,
    name: string,
  ): Promise<string> {
    const settings = await loadSettings();
    const slug = deriveBranchName(name, settings.conventionalCommits);
    if (!slug) return "";
    const prefix = effectiveBranchPrefix(
      settings,
      stackCache.get(threadId)?.payload.detectedBranchPrefix ?? null,
    );
    return `${prefix ?? ""}${slug}`;
  }

  // Waiters for hidden helper threads (Suggest): resolved by the idle/failed
  // lifecycle events below.
  const idleWaiters = new Map<string, (text: string | null) => void>();
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const waiter = idleWaiters.get(thread.id);
    if (waiter) {
      idleWaiters.delete(thread.id);
      waiter(lastAssistantText);
    }
    // The agent just finished a turn — the workspace likely changed. Refresh
    // watched threads so open panels update without a manual Refresh. Skip
    // when the cache is seconds old: back-to-back idle events would each pay
    // the full gh cost for a result that already includes the change.
    const entry = stackCache.get(thread.id);
    if (
      entry &&
      Date.now() - entry.lastReadAt < STACK_WATCH_MS &&
      Date.now() - entry.fetchedAt > STACK_IDLE_COALESCE_MS
    ) {
      refreshStackInBackground(thread.id);
    }
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    stackCache.delete(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    const waiter = idleWaiters.get(thread.id);
    if (waiter) {
      idleWaiters.delete(thread.id);
      waiter(null);
    }
  });

  function waitForIdle(threadId: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        idleWaiters.delete(threadId);
        resolve(null);
      }, timeoutMs);
      // Timeout versus waiter is a deliberate race: whichever arrives first
      // settles, and the waiter path clears the timer so the other cannot.
      idleWaiters.set(threadId, (text) => {
        clearTimeout(timer);
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve(text);
      });
    });
  }

  type Workspace =
    | { cwd: string; error: null }
    | { cwd: null; error: { kind: StackErrorKind; message: string } };

  async function resolveWorkspace(threadId: string): Promise<Workspace> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      return {
        cwd: null,
        error: {
          kind: "no-environment",
          message: "This thread has no workspace environment.",
        },
      };
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.path || !environment.isGitRepo) {
      return {
        cwd: null,
        error: {
          kind: "no-environment",
          message: "This thread's environment is not a git workspace.",
        },
      };
    }
    // gh runs on the BB server host; a workspace on a remote machine
    // won't exist here.
    if (!existsSync(environment.path)) {
      return {
        cwd: null,
        error: {
          kind: "workspace-missing",
          message: `Workspace path ${environment.path} does not exist on the BB server host (remote environments are not supported).`,
        },
      };
    }
    return { cwd: environment.path, error: null };
  }

  // Recompute one thread's stack, cache it, and announce the fresh payload so
  // every open panel refetches. Concurrent calls share one compute.
  function refreshStack(threadId: string): Promise<StackPayload> {
    const inflight = stackInflight.get(threadId);
    if (inflight) return inflight;
    const promise = computeStack(threadId)
      .then(async (payload) => {
        // computeStack read the settings when it started; a save landing
        // mid-compute would otherwise be overwritten by that older copy.
        const settings = await loadSettings();
        const stamped: StackPayload = {
          ...payload,
          settings,
          branchPrefix: effectiveBranchPrefix(
            settings,
            payload.detectedBranchPrefix,
          ),
        };
        const fetchedAt = Date.now();
        // A background recompute is not a read: keep the old lastReadAt.
        const lastReadAt = stackCache.get(threadId)?.lastReadAt ?? 0;
        stackCache.set(threadId, { payload: stamped, fetchedAt, lastReadAt });
        bb.realtime.publish("stack-updated", { threadId, fetchedAt });
        return stamped;
      })
      .finally(() => stackInflight.delete(threadId));
    stackInflight.set(threadId, promise);
    return promise;
  }

  function refreshStackInBackground(threadId: string): void {
    refreshStack(threadId).catch((error: unknown) => {
      bb.log.warn(
        `background stack refresh failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function computeStack(threadId: string): Promise<StackPayload> {
    const settings = await loadSettings();
    // A configured prefix wins over whatever the workspace's branches share.
    const effectivePrefix = (detected: string | null): string | null =>
      effectiveBranchPrefix(settings, detected);
    const workspace = await resolveWorkspace(threadId);
    if (workspace.error) {
      return {
        stack: null,
        workspacePath: null,
        error: workspace.error,
        pending: null,
        defaultBranch: null,
        branchPrefix: effectivePrefix(null),
        detectedBranchPrefix: null,
        settings,
        nextPrNumber: null,
      };
    }
    const cwd = workspace.cwd;

    await freshenRemoteRefs(cwd);
    const [result, pending, defaultBranch, headPrefix, next] =
      await Promise.all([
        runGh(["stack", "view", "--json"], cwd, 30_000),
        pendingChangeSet(cwd),
        defaultBranchName(cwd),
        currentBranchPrefix(cwd),
        nextPrNumber(cwd),
      ]);
    if (result.code !== 0) {
      return {
        stack: null,
        workspacePath: cwd,
        error: mapExitCode(result),
        pending,
        defaultBranch,
        branchPrefix: effectivePrefix(headPrefix),
        detectedBranchPrefix: headPrefix,
        settings,
        nextPrNumber: next,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      return {
        stack: null,
        workspacePath: cwd,
        error: {
          kind: "other" as const,
          message: "gh stack view returned unparseable JSON.",
        },
        pending,
        defaultBranch,
        branchPrefix: effectivePrefix(headPrefix),
        detectedBranchPrefix: headPrefix,
        settings,
        nextPrNumber: next,
      };
    }
    const parsed = stackSchema.safeParse(raw);
    if (!parsed.success) {
      bb.log.warn(`unexpected gh stack view shape: ${parsed.error.message}`);
      return {
        stack: null,
        workspacePath: cwd,
        error: {
          kind: "other" as const,
          message: "gh stack view returned an unexpected JSON shape.",
        },
        pending,
        defaultBranch,
        branchPrefix: effectivePrefix(headPrefix),
        detectedBranchPrefix: headPrefix,
        settings,
        nextPrNumber: next,
      };
    }

    // Enrich each branch concurrently: PR title + draft status (a failed
    // lookup degrades to state-only) and the diff against its stack parent
    // (the branch below, or the trunk for the bottom branch).
    const rawBranches = parsed.data.branches;
    const trunkBehindPromise = revListCount(
      cwd,
      parsed.data.trunk,
      `origin/${parsed.data.trunk}`,
    );
    const branches = await Promise.all(
      rawBranches.map(async (branch, index) => {
        const parent = index === 0 ? parsed.data.trunk : rawBranches[index - 1].name;
        const diffPromise = branchChangeSet(cwd, parent, branch.name);
        // With a remote branch, unpushed = local commits origin lacks. With
        // none (never pushed), every commit over the stack parent is
        // unpushed — reporting null there would read as "fully pushed".
        const remoteProbe = runGit(
          ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch.name}`],
          cwd,
        );
        const aheadPromise = remoteProbe.then((hasRemote) =>
          hasRemote.code === 0
            ? revListCount(cwd, `origin/${branch.name}`, branch.name)
            : revListCount(cwd, parent, branch.name),
        );
        const behindPromise = remoteProbe.then((hasRemote) =>
          hasRemote.code === 0
            ? revListCount(cwd, branch.name, `origin/${branch.name}`)
            : 0,
        );
        if (!branch.pr) {
          return Object.assign({}, branch, {
            pr: null,
            diff: await diffPromise,
            aheadOfRemote: await aheadPromise,
            behindRemote: await behindPromise,
          });
        }
        const view = await runGh(
          ["pr", "view", String(branch.pr.number), "--json", "title,isDraft"],
          cwd,
          20_000,
        );
        let title: string | null = null;
        let isDraft = false;
        if (view.code === 0) {
          try {
            const enriched = prEnrichSchema.parse(JSON.parse(view.stdout));
            title = enriched.title || null;
            isDraft = enriched.isDraft;
          } catch {
            // keep state-only
          }
        }
        return Object.assign({}, branch, {
          pr: Object.assign({}, branch.pr, { title, isDraft }),
          diff: await diffPromise,
          aheadOfRemote: await aheadPromise,
          behindRemote: await behindPromise,
        });
      }),
    );
    // The stack's own namespace wins over the checked-out branch's.
    const detected =
      branchPrefixOf(branches.map((branch) => branch.name)) ?? headPrefix;
    return {
      stack: { ...parsed.data, branches, trunkBehind: await trunkBehindPromise },
      workspacePath: cwd,
      error: null,
      pending,
      defaultBranch,
      branchPrefix: effectivePrefix(detected),
      detectedBranchPrefix: detected,
      settings,
      nextPrNumber: next,
    };
  }

  bb.rpc.register(rpcContract, {
    async getStack({ threadId, refresh }) {
      const cached = stackCache.get(threadId);
      if (refresh !== true && cached) {
        cached.lastReadAt = Date.now();
        if (Date.now() - cached.fetchedAt > STACK_FRESH_MS) {
          refreshStackInBackground(threadId);
        }
        // The cache holds what GitHub reported; the overlay is what the user
        // has since asked for and gh accepted.
        return {
          ...applyDraftIntents(cached.payload),
          fetchedAt: cached.fetchedAt,
        };
      }
      const payload = await refreshStack(threadId);
      const entry = stackCache.get(threadId);
      if (entry) entry.lastReadAt = Date.now();
      return {
        ...applyDraftIntents(payload),
        fetchedAt: entry?.fetchedAt ?? Date.now(),
      };
    },

    async setPrDraft({ threadId, prNumber, draft }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;

      // Claim the new state before the command runs, not after: a background
      // compute that lands while gh is still working would otherwise serve the
      // old pill to every panel.
      draftIntents.set(prNumber, { draft, at: Date.now() });
      republish(threadId);

      const args = draft
        ? ["pr", "ready", String(prNumber), "--undo"]
        : ["pr", "ready", String(prNumber)];
      bb.log.info(`running gh ${args.join(" ")} in ${cwd}`);
      const result = await runGh(args, cwd, 30_000);
      const detail = outputTail(result);
      if (result.failedToSpawn || result.timedOut || result.code !== 0) {
        // The write never landed — drop the claim and announce, so the pill
        // reverts to what GitHub reports instead of holding a state that does
        // not exist.
        draftIntents.delete(prNumber);
        republish(threadId);
        const reason = result.stderr.trim().split("\n").pop() ?? "";
        return {
          ok: false,
          message:
            reason || `gh pr ready exited with code ${result.code}.`,
          detail,
        };
      }
      // Converge in the background: the overlay carries the pill until one of
      // these computes comes back agreeing, which retires it.
      refreshStackInBackground(threadId);
      return {
        ok: true,
        message: draft
          ? `PR #${prNumber} converted to draft.`
          : `PR #${prNumber} marked ready for review.`,
        detail,
      };
    },

    async checkoutBranch({ threadId, branch }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;
      const payload =
        stackCache.get(threadId)?.payload ?? (await refreshStack(threadId));
      const target = payload.stack?.branches.find(
        (candidate) => candidate.name === branch,
      );
      if (!target) {
        return {
          ok: false,
          message: `${branch} is not in this stack anymore. Refresh the panel.`,
          detail: null,
        };
      }
      if (target.isCurrent) {
        return { ok: true, message: `Already on ${branch}.`, detail: null };
      }

      // git's `error:` line names a blocker (usually local changes that
      // would be overwritten); the last line is just "Aborting".
      const gitReason = (result: GhResult): string => {
        const lines = result.stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return (lines.find((line) => line.startsWith("error:")) ?? lines[0] ?? "")
          .replace(/^error:\s*/, "")
          .replace(/:$/, ".");
      };

      // Smart checkout. Plain first: changes that don't conflict with the
      // switch ride along, as with git on the command line. Only when git
      // refuses are the local changes stashed — tagged with the branch they
      // belong to — and the stash comes back automatically the next time
      // that branch is checked out from here.
      bb.log.info(`running git checkout ${branch} in ${cwd}`);
      let stashedFrom: string | null = null;
      let result = await runGit(["checkout", branch], cwd);
      if (
        result.code !== 0 &&
        /would be overwritten|commit your changes or stash them/i.test(
          result.stderr,
        )
      ) {
        const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
        const from = head.code === 0 ? head.stdout.trim() : "HEAD";
        // Tracked changes only: -u would sweep every unrelated untracked
        // file into the stash too. An untracked file the checkout would
        // overwrite stays a plain error.
        const stash = await runGit(
          ["stash", "push", "-m", `${AUTO_STASH_PREFIX}${from}`],
          cwd,
        );
        if (stash.code !== 0) {
          return {
            ok: false,
            message: `Local changes block the checkout and could not be stashed: ${gitReason(stash) || "git stash failed"}`,
            detail: outputTail(stash),
          };
        }
        stashedFrom = from;
        result = await runGit(["checkout", branch], cwd);
        if (result.code !== 0) {
          // Leave the tree the way it was found rather than checked-out
          // nowhere with the work sitting in a surprise stash.
          await runGit(["stash", "pop"], cwd);
          stashedFrom = null;
        }
      }
      if (result.code !== 0) {
        return {
          ok: false,
          message:
            gitReason(result) ||
            `git checkout exited with code ${result.code}.`,
          detail: outputTail(result),
        };
      }

      // Coming back to a branch that had its changes auto-stashed: restore
      // them. Pop keeps the stash entry when the apply conflicts, so nothing
      // is lost either way.
      const restored = await popAutoStash(cwd, branch);
      const parts = [`Checked out ${branch}.`];
      if (stashedFrom) {
        parts.push(
          `Local changes were stashed for ${stashedFrom} and come back when it is checked out again.`,
        );
      }
      if (restored === "restored") {
        parts.push("Its stashed changes are back in the working tree.");
      } else if (restored === "conflict") {
        parts.push(
          "Restoring its stashed changes hit conflicts — resolve them in the working tree (the stash entry was kept).",
        );
      }
      return { ok: true, message: parts.join(" "), detail: null };
    },

    async runAction({ threadId, action }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;

      // One gh stack invocation; failure message comes from the exit code,
      // plus the divergence case where sync exits 0 without changing anything.
      const runStep = async (
        args: string[],
      ): Promise<{
        failure: string | null;
        kind: StackErrorKind | null;
        detail: string | null;
      }> => {
        bb.log.info(`running gh ${args.join(" ")} in ${cwd}`);
        const result = await runGh(args, cwd, 180_000);
        const detail = outputTail(result);
        if (result.code !== 0) {
          const mapped = mapExitCode(result);
          return { failure: mapped.message, kind: mapped.kind, detail };
        }
        if (
          args[1] === "sync" &&
          /sync aborted/i.test(`${result.stdout}${result.stderr}`)
        ) {
          return {
            failure:
              "Local and remote stacks diverged; sync aborted with no changes. See the command output for both chains.",
            kind: "sync-aborted",
            detail,
          };
        }
        return { failure: null, kind: null, detail };
      };

      // A sync that needs judgement — a rebase conflict to resolve, or a
      // local/remote divergence to reconcile — is not something a button
      // retry fixes. Hand it straight to the thread's agent (which has the
      // gh-stack skill) instead of bouncing the failure back to the user.
      // The prompt is composed from these static strings only: mapExitCode
      // messages are panel copy ("Run Sync…") that would read nonsense to
      // the agent, and command output could carry attacker-influenced
      // branch names or commit subjects.
      const handOffToAgent = async (kind: StackErrorKind): Promise<boolean> => {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          await bb.sdk.threads.send({
            threadId,
            mode: "auto",
            ...agentRunOverrides(thread.providerId),
            input: [
              {
                type: "text",
                text: [
                  "Sync this workspace's stack (follow the gh-stack skill). A panel-initiated `gh stack sync` just failed:",
                  kind === "rebase-conflict"
                    ? "It hit a rebase conflict (exit 3); gh stack restored the branches before exiting."
                    : "The local and remote stacks have diverged; sync aborted without making changes.",
                  kind === "rebase-conflict"
                    ? "Recreate the conflict with `gh stack rebase`, resolve the files, `git add` them, then `gh stack rebase --continue` and finish with `gh stack sync`."
                    : "Run `gh stack sync` to print both chains, compare them, reconcile, then run it to completion.",
                  action === "sync-submit"
                    ? "When the sync is clean, run `gh stack submit --auto` and confirm with `gh stack view --json`."
                    : "Confirm the result with `gh stack view --json`.",
                  "Report what you did.",
                ].join("\n"),
                mentions: [],
              },
            ],
          });
          return true;
        } catch (error: unknown) {
          bb.log.warn(
            `sync hand-off failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      };

      const steps: { args: string[]; success: string }[] =
        action === "sync"
          ? [
              {
                args: ["stack", "sync"],
                success:
                  "Stack synced: fetched, rebased, pushed, and PR state refreshed.",
              },
            ]
          : action === "prune"
            ? [
                {
                  args: ["stack", "sync", "--prune"],
                  success:
                    "Stack synced and local branches for merged PRs deleted.",
                },
              ]
            : action === "submit"
              ? [
                  {
                    args: ["stack", "submit", "--auto"],
                    success:
                      "Stack submitted: branches pushed and draft PRs opened.",
                  },
                ]
              : [
                  { args: ["stack", "sync"], success: "" },
                  {
                    args: ["stack", "submit", "--auto"],
                    success:
                      "Stack restacked and submitted: synced with the remote, then pushed branches and opened draft PRs.",
                  },
                ];

      let detail: string | null = null;
      let success = "";
      for (const [index, step] of steps.entries()) {
        const outcome = await runStep(step.args);
        detail = outcome.detail ?? detail;
        if (outcome.failure) {
          // Non-trivial sync failures go to the agent automatically. Prune is
          // excluded: its sync deletes branches afterwards, and that should
          // not happen as a side effect of an autonomous recovery.
          if (
            step.args[1] === "sync" &&
            action !== "prune" &&
            (outcome.kind === "rebase-conflict" ||
              outcome.kind === "sync-aborted")
          ) {
            const HANDOFF_COOLDOWN_MS = 10 * 60_000;
            const lastHandoff = syncHandoffAt.get(threadId) ?? 0;
            if (Date.now() - lastHandoff < HANDOFF_COOLDOWN_MS) {
              return {
                ok: false,
                message:
                  "This is already with the thread's agent — watch the conversation. (The stack still reports the failure while the agent works.)",
                detail,
              };
            }
            if (await handOffToAgent(outcome.kind)) {
              syncHandoffAt.set(threadId, Date.now());
              const job = action === "sync-submit" ? "sync + submit" : "the sync";
              return {
                ok: true,
                message:
                  outcome.kind === "rebase-conflict"
                    ? `Sync hit a rebase conflict — handed ${job} to this thread's agent. Watch the conversation.`
                    : `Local and remote stacks diverged — handed ${job} to this thread's agent. Watch the conversation.`,
                detail,
              };
            }
          }
          const remaining = steps.length - index - 1;
          return {
            ok: false,
            message:
              remaining > 0
                ? `${outcome.failure} Submit was not run.`
                : outcome.failure,
            detail,
          };
        }
        success = step.success || success;
      }
      // A clean run means the stack converged — any earlier handoff is done
      // (or moot), so a future failure may hand off again.
      syncHandoffAt.delete(threadId);
      return { ok: true, message: success, detail };
    },

    async mergeStack({ threadId, method, throughPrNumber }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;

      // Merging is irreversible and outward-facing, so decide the merge set
      // from a fresh compute rather than whatever the cache last saw — with
      // the draft overlay applied, so a PR readied moments ago is not read
      // back as a draft and refused.
      const payload = applyDraftIntents(await refreshStack(threadId));
      const stack = payload.stack;
      if (!stack) {
        return {
          ok: false,
          message:
            payload.error?.message ?? "This workspace has no stack to merge.",
          detail: null,
        };
      }
      const unmerged = stack.branches.filter((branch) => !branch.isMerged);
      if (unmerged.length === 0) {
        return {
          ok: false,
          message: "Every branch in this stack is already merged.",
          detail: null,
        };
      }
      // A layer can only merge once every layer under it has: its PR targets
      // the branch below. So the merge set is a run from the trunk up, and it
      // stops at the first branch GitHub would refuse — one with no PR, or one
      // still in draft. Layers above that stay open; nothing waits on them.
      const ready: typeof unmerged = [];
      for (const branch of unmerged) {
        if (!branch.pr || branch.pr.isDraft) break;
        ready.push(branch);
      }
      if (ready.length === 0) {
        const blocker = unmerged[0];
        return {
          ok: false,
          message: blocker.pr
            ? `#${blocker.pr.number} sits at the bottom of the stack and is still a draft, so nothing above it can merge. Mark it ready, then merge.`
            : `${blocker.name} sits at the bottom of the stack and has no pull request yet, so nothing above it can merge. Run Submit first.`,
          detail: null,
        };
      }
      // Honour the PR the panel offered to stop at rather than however far the
      // run reaches now: a layer that went ready between the dialog opening
      // and the click must not be merged unasked.
      if (throughPrNumber !== undefined) {
        const index = ready.findIndex(
          (branch) => branch.pr?.number === throughPrNumber,
        );
        if (index === -1) {
          return {
            ok: false,
            message: `PR #${throughPrNumber} cannot be merged from here anymore — it is merged, a draft, or a layer below it is. Refresh the panel.`,
            detail: null,
          };
        }
        ready.length = index + 1;
      }
      const top = ready[ready.length - 1].pr;
      if (!top) {
        return { ok: false, message: "The top branch has no pull request.", detail: null };
      }

      // Submit the atomic stack merge, addressed by the target PR's number —
      // GitHub merges it and every unmerged PR below it in the stack, or
      // nothing. merge_action "default" lets the server route to the base
      // branch's merge queue when it has one.
      const endpoint = `repos/{owner}/{repo}/pulls/${top.number}/merge-async`;
      bb.log.info(`PUT ${endpoint} (${method}) in ${cwd}`);
      const submit = await runGh(
        [
          "api",
          "--method",
          "PUT",
          endpoint,
          "-f",
          `merge_method=${method}`,
          "-f",
          "merge_action=default",
        ],
        cwd,
        30_000,
      );
      const count = ready.length;
      const left = unmerged.length - count;
      // A partial merge leaves the layers above sitting on branches that are
      // now in the trunk, so name the follow-up.
      const rest =
        left > 0
          ? ` The ${left} layer${left === 1 ? "" : "s"} above stay open — run Sync to restack ${left === 1 ? "it" : "them"} onto ${stack.trunk}.`
          : "";
      const finish = (outcome: AsyncMergeResult, detail: string | null) => {
        if (outcome.status === "failed") {
          // Atomic: nothing was merged. details.message names the blocker
          // (a conflict, an unmet branch rule).
          return {
            ok: false,
            message: `The merge could not complete and nothing was merged: ${outcome.details.message || "GitHub reported a failure with no reason."}`,
            detail,
          };
        }
        if (outcome.status === "enqueued") {
          return {
            ok: true,
            message: `${count} pull request${count === 1 ? "" : "s"} added to the merge queue on ${stack.trunk}; they land as the queue processes them.${rest}`,
            detail,
          };
        }
        const shape =
          method === "squash"
            ? "one commit per branch"
            : method === "rebase"
              ? "every commit replayed"
              : "one merge commit per branch";
        return {
          ok: true,
          message: `Merged ${count} branch${count === 1 ? "" : "es"} into ${stack.trunk} — ${shape}.${rest}`,
          detail,
        };
      };

      // gh api exits non-zero on any non-2xx but still prints the response
      // body, so the reason (400) or the existing request's uuid (409)
      // survives — read the body first, then the status line.
      let result = parseAsyncMergeBody(submit.stdout);
      if (submit.code !== 0) {
        const http = `${submit.stderr}`.match(/HTTP (\d{3})/)?.[1];
        if (http === "404") {
          return {
            ok: false,
            message:
              "GitHub's stack merge API is not available for this repository (or the pull request was not found). Nothing was merged.",
            detail: outputTail(submit),
          };
        }
        // 409: a merge request already exists for this stack — its uuid is in
        // the body, so fall through and poll that instead of failing.
        if (http !== "409" || !result?.details.uuid) {
          return {
            ok: false,
            message:
              result?.details.message ||
              `The merge could not be submitted (HTTP ${http ?? "error"}). Nothing was merged.`,
            detail: outputTail(submit),
          };
        }
        bb.log.info(`merge request already exists; polling ${result.details.uuid}`);
      }
      if (!result) {
        return {
          ok: false,
          message: "GitHub returned an unexpected response to the merge request.",
          detail: outputTail(submit),
        };
      }

      // The submit can resolve immediately; otherwise poll the uuid until the
      // status leaves "pending" ("merged", "enqueued", and "failed" are all
      // terminal).
      const deadline = Date.now() + MERGE_POLL_DEADLINE_MS;
      while (result.status === "pending") {
        const uuid: string | undefined = result.details.uuid;
        if (!uuid || !MERGE_UUID.test(uuid)) {
          return {
            ok: false,
            message:
              "GitHub accepted the merge but returned no pollable id. Refresh the panel in a minute to see whether it landed.",
            detail: outputTail(submit),
          };
        }
        if (Date.now() > deadline) {
          return {
            ok: true,
            message: `The merge of ${count} pull request${count === 1 ? "" : "s"} is still running on GitHub's side. Refresh the panel in a minute to see the result.`,
            detail: null,
          };
        }
        await sleep(MERGE_POLL_INTERVAL_MS);
        const poll = await runGh(["api", `${endpoint}/${uuid}`], cwd, 15_000);
        const polled = parseAsyncMergeBody(poll.stdout);
        if (!polled) {
          return {
            ok: false,
            message:
              "Lost track of the running merge (the poll failed). Refresh the panel in a minute to see whether it landed.",
            detail: outputTail(poll),
          };
        }
        // Carry the uuid forward: poll responses include it only while
        // pending, and a terminal one does not need it.
        result = {
          ...polled,
          details: { ...polled.details, uuid: polled.details.uuid ?? uuid },
        };
      }
      return finish(result, null);
    },

    async createStack({ threadId, name, branch: requested }) {
      // The panel sends the branch it previewed; deriving here is the
      // fallback for callers that only pass a name.
      const branch = requested ?? (await deriveWithSettings(threadId, name));
      if (!branch || !BRANCH_NAME.test(branch)) {
        return {
          ok: false,
          message:
            "Could not derive a branch name from that stack name. Use at least one letter or digit.",
          detail: null,
        };
      }
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;

      bb.log.info(`running gh stack init ${branch} in ${cwd}`);
      const result = await runGh(["stack", "init", branch], cwd, 60_000);
      const detail = outputTail(result);
      if (result.code !== 0) {
        return { ok: false, message: mapExitCode(result).message, detail };
      }
      return {
        ok: true,
        message: `Stack created; ${branch} is checked out.`,
        detail,
      };
    },

    async addBranch({ threadId, name, branch: requested }) {
      const branch = requested ?? (await deriveWithSettings(threadId, name));
      if (!branch || !BRANCH_NAME.test(branch)) {
        return {
          ok: false,
          message:
            "Could not derive a branch name from that name. Use at least one letter or digit.",
          detail: null,
        };
      }
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;

      // gh stack add only works from the top branch; navigate there first.
      // Uncommitted changes follow the checkout onto the new branch.
      bb.log.info(`running gh stack top && gh stack add ${branch} in ${cwd}`);
      const top = await runGh(["stack", "top"], cwd, 30_000);
      if (top.failedToSpawn || top.timedOut || top.code !== 0) {
        return { ok: false, message: mapExitCode(top).message, detail: outputTail(top) };
      }
      const result = await runGh(["stack", "add", branch], cwd, 60_000);
      const detail = outputTail(result);
      if (result.code !== 0) {
        const message =
          result.code === 5
            ? "gh stack add must run from the top of the stack; navigating there failed."
            : mapExitCode(result).message;
        return { ok: false, message, detail };
      }
      return {
        ok: true,
        message: `${branch} stacked on top and checked out; uncommitted changes carried along.`,
        detail,
      };
    },

    async suggestStackName({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      const settings = await loadSettings();

      // Heuristic fallback when the agent path is unavailable or times out.
      let fallback = (thread.title ?? thread.titleFallback ?? "").trim();
      if (!fallback && thread.environmentId) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        const branchName = environment.branchName;
        if (branchName && branchName !== environment.defaultBranch) {
          fallback = humanizeBranch(branchName);
        }
      }
      fallback = fallback.slice(0, 72) || "New stack";

      if (!thread.environmentId) return { name: fallback };

      // Ask the thread's own harness: hidden helper thread in the same
      // environment and provider, read-only naming task.
      try {
        const helper = await bb.sdk.threads.spawn({
          projectId: thread.projectId,
          environment: { type: "reuse", environmentId: thread.environmentId },
          providerId: thread.providerId,
          ...agentRunOverrides(thread.providerId),
          visibility: "hidden",
          title: "gh-stack: suggest stack name",
          prompt: suggestNamePrompt(settings.conventionalCommits),
        });
        const text = await waitForIdle(helper.id, 90_000);
        void bb.sdk.threads
          .delete({ threadId: helper.id, childThreadsConfirmed: true })
          .catch(() => {});
        const name = text ? sanitizeTitle(text) : "";
        if (!name) {
          bb.log.warn("suggestStackName: helper thread returned no title; using fallback");
        }
        return { name: name || fallback };
      } catch (error) {
        bb.log.warn(
          `suggestStackName: helper thread failed (${error instanceof Error ? error.message : String(error)}); using fallback`,
        );
        return { name: fallback };
      }
    },

    async autoStack({ threadId }) {
      // Fail early with a clear message when the workspace can't stack at all.
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      // An existing stack must be extended, not re-initialized.
      const view = await runGh(["stack", "view", "--json"], workspace.cwd, 30_000);
      const hasStack = view.code === 0;
      // Hand the agent the same naming rules the composer follows.
      const settings = await loadSettings();
      const detectedPrefix =
        stackCache.get(threadId)?.payload.detectedBranchPrefix ??
        (await currentBranchPrefix(workspace.cwd));
      const thread = await bb.sdk.threads.get({ threadId });
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        ...agentRunOverrides(thread.providerId),
        input: [
          {
            type: "text",
            text: hasStack
              ? autoExtendPrompt(settings, detectedPrefix)
              : autoCreatePrompt(settings, detectedPrefix),
            mentions: [],
          },
        ],
      });
      return {
        ok: true,
        message: hasStack
          ? "Asked this thread's agent to split the remaining work into more layers. Watch the conversation for progress."
          : "Asked this thread's agent to split the work into a stack. Watch the conversation for progress.",
        detail: null,
      };
    },

    async saveSettings({ branchPrefix, conventionalCommits }) {
      const normalized = normalizeBranchPrefix(branchPrefix);
      if ("error" in normalized) {
        return {
          ok: false,
          message: normalized.error,
          settings: await loadSettings(),
        };
      }
      const next: Settings = {
        branchPrefix: normalized.prefix,
        conventionalCommits,
      };
      await bb.storage.kv.set(SETTINGS_KEY, next);
      settingsCache = next;
      // Cached payloads only carry settings and the prefix derived from them,
      // so patch them in place rather than paying for a gh recompute — and
      // announce each patched thread so panels beyond the saving one adopt
      // the new prefix now instead of on their next poll.
      for (const [cachedThreadId, entry] of stackCache) {
        entry.payload = {
          ...entry.payload,
          settings: next,
          branchPrefix: effectiveBranchPrefix(
            next,
            entry.payload.detectedBranchPrefix,
          ),
        };
        bb.realtime.publish("stack-updated", {
          threadId: cachedThreadId,
          fetchedAt: entry.fetchedAt,
        });
      }
      bb.log.info(
        `settings saved: prefix="${next.branchPrefix}" conventionalCommits=${next.conventionalCommits}`,
      );
      return { ok: true, message: null, settings: next };
    },
  });
}
