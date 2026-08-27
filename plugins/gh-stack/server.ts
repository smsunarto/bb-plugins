// @smsunarto/bb-plugin-gh-stack — stacked-PR visibility and actions for BB threads.
//
// Runs `gh stack` commands in a thread's workspace (server host):
// view --json for the panel, plus sync / submit / init actions.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  buildChangeSet,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainZ,
  parseWcLines,
  type ChangeSet,
  type DiffCounts,
} from "./lib/git-diff";
import { deriveBranchName, isBranchCandidate, normalizeBranchPrefix } from "./lib/branch-name";
import {
  isCurrentBranchNotInStack,
  partialSuccessWarning,
  requiresAgentSyncRecovery,
} from "./lib/gh-stack-output";
import {
  hasExtendableLayers,
  projectStackLayers,
  type StackLayerCheckout,
} from "./lib/stack-layers";
import {
  activeAutoStashOwners,
  checkoutWithAutoStash,
  stashCountsByBranch,
} from "./lib/smart-checkout";
import { resolveWorkspaceKey } from "./lib/workspace-key";
import {
  applyPrMetadataReads,
  evictAbsentPrMetadata,
  partitionPrMetadata,
  type PrMetadata,
  type PrMetadataCache,
  type PrMetadataResolution,
} from "./lib/pr-metadata";
import {
  mergePrefix,
  pruneCandidates,
  stackMergeArgs,
  stackMergeWasQueued,
} from "./lib/stack-actions";

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

// Wire shape after enriching each PR with title/isDraft from GitHub
// (gh stack view --json exposes neither).
const prOutSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string(),
  title: z.string().nullable(),
  isDraft: z.boolean(),
  // True when GitHub could not be read for this PR, so title/isDraft are a
  // previous read or a placeholder. The panel must not present such values as
  // current, and must not offer the draft toggle over them.
  metadataStale: z.boolean(),
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
  // True while tracked changes for this branch wait in a plugin auto-stash,
  // which the plugin restores on checkout.
  hasStash: z.boolean(),
  // Stash entries Git holds for this branch, whoever made them — this
  // plugin's auto-stashes, `git stash` by hand, another tool. Zero when there
  // are none; null when the stash list could not be read.
  stashCount: z.number().int().nonnegative().nullable(),
  pr: prOutSchema.nullable(),
  // Present and true only when the returned draft value is an optimistic
  // server overlay over a GitHub read that has not caught up yet.
  draftReconciliationPending: z.boolean().optional(),
  // Diff against the branch's stack parent (the branch below, or the trunk).
  diff: changeSetSchema.nullable(),
  // Commit distance from the fetched remote branch. Null means remote refs
  // could not be refreshed safely; a missing remote branch is ahead of its
  // stack parent and zero behind.
  aheadOfRemote: z.number().nullable(),
  behindRemote: z.number().nullable(),
});

const stackOutSchema = z.object({
  trunk: z.string(),
  currentBranch: z.string().nullable(),
  branches: z.array(branchOutSchema),
  // Commits the local trunk is behind its fetched origin ref. Null is unknown.
  trunkBehind: z.number().nullable(),
  // Existing local merged-layer refs, or null when any ref probe failed.
  prunableBranchCount: z.number().int().nonnegative().nullable(),
});

const prEnrichSchema = z.object({
  title: z.string().catch(""),
  isDraft: z.boolean().catch(false),
  state: z.string().catch(""),
});

// One row of `gh pr list --json number,title,isDraft,state`.
const prListRowSchema = z.object({
  number: z.number(),
  title: z.string().catch(""),
  isDraft: z.boolean().catch(false),
  state: z.string().catch(""),
});
const prListSchema = z.array(prListRowSchema);

const prMutationStateSchema = z.object({
  isDraft: z.boolean(),
  state: z.string(),
  headRefName: z.string(),
});

const mergeValidationSchema = prMutationStateSchema.extend({
  baseRefName: z.string(),
  mergedAt: z.string().nullable(),
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
  // Optional for compatibility with ordinary success/failure results. Set
  // explicitly when an accepted or partially applied operation must not be
  // presented as either verified success or definite failure.
  tone: z.enum(["success", "warning", "error"]).optional(),
  // Tail of combined command output, for diagnostics in the panel.
  detail: z.string().nullable(),
});

type ActionResult = z.infer<typeof actionResultSchema>;
const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]);

// Panel settings, edited in the gear popup and stored in the plugin's kv.
// Both are lenient on read so a row written by an older build still loads.
const settingsSchema = z.object({
  // Namespace put in front of every derived branch ("scott/"). Empty means
  // "match the branches already in the workspace" (the detected prefix).
  branchPrefix: z.string().catch(""),
  // Layer and PR titles read as Conventional Commits, scope optional
  // ("feat(api): add rate limiting"). The derived branch carries the type but
  // not the scope ("scott/feat-add-rate-limiting").
  conventionalCommits: z.boolean().catch(false),
});

export type Settings = z.infer<typeof settingsSchema>;

const DEFAULT_SETTINGS: Settings = {
  branchPrefix: "",
  conventionalCommits: false,
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
  // A merged layer is still hidden when automatic checkout must wait or
  // fails. This warning explains why the workspace remains on that branch.
  checkoutWarning: z.string().nullable(),
  // Uncommitted working-tree changes — what would carry onto a newly
  // stacked branch. Present whenever the workspace resolves, including
  // the not-a-stack case (it feeds the create form too).
  pending: changeSetSchema.nullable(),
  // The repository's default branch, so the rail can name its base
  // before a stack exists (a stack reports its own trunk).
  defaultBranch: z.string().nullable(),
  // Namespace a proposed branch gets: the configured prefix when the
  // settings popup sets one, else the namespace the workspace's branches
  // already share ("scott/"), so a new branch reads like the existing ones.
  branchPrefix: z.string().nullable(),
  // Only the detected half of the above, so the settings popup can offer it
  // as the placeholder for an empty prefix field.
  detectedBranchPrefix: z.string().nullable(),
  // The settings in force, as stored — branchPrefix here is the raw
  // configured value ("" when unset), not the effective one above.
  settings: settingsSchema,
});

export const rpcContract = defineRpcContract({
  // Stale-while-revalidate: without `refresh` a cached payload is returned
  // immediately and, when stale, recomputed in the background — the fresh
  // result is announced on the "stack-updated" realtime channel. With
  // `refresh: true` the call waits for a fresh compute.
  getStack: {
    input: z.object({ threadId: z.string(), refresh: z.boolean().optional() }).strict(),
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
  // Check out a visible layer in the current stack. The handler validates the
  // branch against a fresh stack view, so the browser cannot select an
  // arbitrary local ref or a merged layer hidden from the panel.
  checkoutBranch: {
    input: z.object({ threadId: z.string(), branch: z.string().min(1).max(255) }).strict(),
    output: actionResultSchema,
  },
  runAction: {
    input: z
      .object({
        threadId: z.string(),
        action: z.enum(["sync", "submit", "sync-submit", "prune"]),
      })
      .strict(),
    output: actionResultSchema,
  },
  mergeStack: {
    input: z
      .object({
        threadId: z.string(),
        method: mergeMethodSchema.default("squash"),
        // Required so every irreversible request is pinned to the exact
        // prefix shown in the confirmation dialog.
        throughPrNumber: z.number().int().positive(),
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
  magicStack: {
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
      if (isCurrentBranchNotInStack(result.code, result.stderr)) {
        return {
          kind: "not-a-stack",
          message:
            "This workspace's branch is not part of a stack. Create one below or run gh stack init <branch>.",
        };
      }
      return {
        kind: "other",
        message: detail || "gh stack could not inspect the current stack.",
      };
    case 3:
      return {
        kind: "rebase-conflict",
        message: "Rebase conflict. This needs repository-aware recovery before Sync can finish.",
      };
    case 7:
      return {
        kind: "rebase-conflict",
        message: "A stack rebase is already in progress and needs recovery before Sync can finish.",
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

type ParsedStackView =
  | { stack: StackView; error: null }
  | { stack: null; error: { kind: StackErrorKind; message: string } };

function parseStackViewResult(result: GhResult): ParsedStackView {
  if (result.code !== 0) return { stack: null, error: mapExitCode(result) };
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return {
      stack: null,
      error: { kind: "other", message: "gh stack view returned unparseable JSON." },
    };
  }
  const parsed = stackSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      stack: null,
      error: {
        kind: "other",
        message: "gh stack view returned an unexpected JSON shape.",
      },
    };
  }
  return { stack: parsed.data, error: null };
}

async function readStackView(cwd: string): Promise<ParsedStackView> {
  return parseStackViewResult(await runGh(["stack", "view", "--json"], cwd, 30_000));
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

// Branch namespace ("scott/") the workspace already uses: the one every
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

async function revListCount(cwd: string, left: string, right: string): Promise<number | null> {
  if (left.startsWith("-") || right.startsWith("-")) return null;
  const result = await runGit(["rev-list", "--count", `${left}..${right}`, "--"], cwd);
  if (result.code !== 0) return null;
  const count = Number(result.stdout.trim());
  return Number.isInteger(count) && count >= 0 ? count : null;
}

const REMOTE_FETCH_FRESH_MS = 90_000;

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
  return buildChangeSet(parseNameStatusZ(nameStatus.stdout), parseNumstatZ(numstat.stdout));
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
  const counts = numstat.code === 0 ? parseNumstatZ(numstat.stdout) : new Map<string, DiffCounts>();
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

async function validateBranchRef(cwd: string, branch: string): Promise<string | null> {
  if (!isBranchCandidate(branch)) {
    return "A branch name must start with a letter or digit and use only letters, digits, and . _ - /.";
  }
  const result = await runGit(["check-ref-format", "--branch", branch], cwd);
  if (result.code === 0) return null;
  return `Git rejected ${branch} as a branch name.`;
}

function joinDetails(...details: Array<string | null>): string | null {
  const joined = details.filter((detail): detail is string => Boolean(detail)).join("\n\n");
  return joined || null;
}

async function localBranchNames(cwd: string): Promise<string[] | null> {
  const result = await runGit(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"], cwd);
  if (result.code !== 0) return null;
  return result.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

async function currentBranchName(cwd: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function localBranchExists(cwd: string, branch: string): Promise<boolean | null> {
  const result = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  if (result.code === 0) return true;
  // show-ref uses 1 specifically for a well-formed ref that does not exist.
  return result.code === 1 ? false : null;
}

type BranchPostcondition = {
  complete: boolean;
  branchExists: boolean;
  stackHasBranch: boolean;
  currentBranch: string | null;
  error: string | null;
};

async function inspectBranchPostcondition(
  cwd: string,
  branch: string,
): Promise<BranchPostcondition> {
  const [view, branchExists, currentBranch] = await Promise.all([
    readStackView(cwd),
    localBranchExists(cwd, branch),
    currentBranchName(cwd),
  ]);
  if (view.error) {
    return {
      complete: false,
      branchExists: branchExists === true,
      stackHasBranch: false,
      currentBranch,
      error: view.error.message,
    };
  }
  const matches = view.stack.branches.filter((candidate) => candidate.name === branch);
  const [match] = matches;
  const top = view.stack.branches.at(-1);
  return {
    complete:
      branchExists === true &&
      matches.length === 1 &&
      match?.isCurrent === true &&
      currentBranch === branch &&
      top?.name === branch,
    branchExists: branchExists === true,
    stackHasBranch: matches.length > 0,
    currentBranch,
    error: null,
  };
}

async function branchesNotAtUpstream(cwd: string, branches: string[]): Promise<string[]> {
  const checks = await Promise.all(
    branches.map(async (branch) => {
      const local = await runGit(
        ["for-each-ref", "--format=%(objectname)%00%(upstream)", `refs/heads/${branch}`],
        cwd,
      );
      if (local.code !== 0 || !local.stdout.trim()) return branch;
      const [localSha = "", upstreamRef = ""] = local.stdout.trim().split("\0");
      if (!localSha || !upstreamRef) return branch;
      const upstream = await runGit(["rev-parse", "--verify", upstreamRef], cwd);
      return upstream.code === 0 && upstream.stdout.trim() === localSha ? null : branch;
    }),
  );
  return checks.filter((branch): branch is string => branch !== null);
}

// One `gh pr list` covers the whole stack, so enrichment costs a single
// GraphQL call per compute instead of one per branch. Numbers the list misses
// (closed PRs past the page, or a PR in another repository) fall back to a
// per-PR read, which is rare and bounded by the stack's height.
const PR_LIST_PAGE = 100;
const PR_FALLBACK_LIMIT = 5;

async function readPrMetadata(cwd: string, numbers: number[]): Promise<Map<number, PrMetadata>> {
  const found = new Map<number, PrMetadata>();
  if (numbers.length === 0) return found;
  const wanted = new Set(numbers);
  const list = await runGh(
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      String(PR_LIST_PAGE),
      "--json",
      "number,title,isDraft,state",
    ],
    cwd,
    30_000,
  );
  if (list.code === 0) {
    try {
      for (const row of prListSchema.parse(JSON.parse(list.stdout))) {
        if (!wanted.has(row.number)) continue;
        found.set(row.number, {
          title: row.title || null,
          isDraft: row.isDraft,
          state: row.state,
        });
      }
    } catch {
      // Unparseable list: every number falls through to the per-PR read.
    }
  }
  const missing = numbers.filter((number) => !found.has(number));
  // A wholesale list failure (rate limit, network) would otherwise turn into
  // one `gh pr view` per branch — exactly the cost this batching removes.
  if (missing.length > PR_FALLBACK_LIMIT) return found;
  await Promise.all(
    missing.map(async (number) => {
      const view = await runGh(
        ["pr", "view", String(number), "--json", "title,isDraft,state"],
        cwd,
        20_000,
      );
      if (view.code !== 0) return;
      try {
        const enriched = prEnrichSchema.parse(JSON.parse(view.stdout));
        found.set(number, {
          title: enriched.title || null,
          isDraft: enriched.isDraft,
          state: enriched.state,
        });
      } catch {
        // keep state-only for this PR
      }
    }),
  );
  return found;
}

async function readPullRequestState(
  cwd: string,
  prNumber: number,
): Promise<
  | { state: z.infer<typeof prMutationStateSchema>; error: null; detail: string | null }
  | { state: null; error: string; detail: string | null }
> {
  const result = await runGh(
    ["pr", "view", String(prNumber), "--json", "state,isDraft,headRefName"],
    cwd,
    20_000,
  );
  const detail = outputTail(result);
  if (result.code !== 0) {
    return {
      state: null,
      error:
        result.stderr.trim().split("\n").pop() || `gh pr view exited with code ${result.code}.`,
      detail,
    };
  }
  try {
    return {
      state: prMutationStateSchema.parse(JSON.parse(result.stdout)),
      error: null,
      detail,
    };
  } catch {
    return {
      state: null,
      error: "gh pr view returned an unexpected JSON shape.",
      detail,
    };
  }
}

function humanizeBranch(branch: string): string {
  const words = branch.replace(/[-_/]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function suggestNamePrompt(conventional: boolean): string {
  return [
    "Inspect the current work in this workspace: uncommitted changes (git status, git diff) and commits not yet on the default branch.",
    conventional
      ? "Then reply with ONLY one Conventional Commits title that describes the work as a whole — `type(scope): subject`, type one of feat, fix, docs, refactor, perf, test, build, ci, chore; scope is the part of the codebase the work touches (a package, module, or directory name, lower case) and is omitted when the work spans several or none fits; subject in imperative mood, lower case, no trailing period; at most 60 characters in total."
      : "Then reply with ONLY one PR-style title that describes the work as a whole — imperative mood, at most 60 characters, no quotes, no trailing period.",
    "Your entire final message must be just the title, nothing else.",
  ].join("\n");
}

function sanitizeTitle(text: string): string {
  let line = "";
  for (const part of text.split("\n")) {
    const trimmed = part.trim();
    if (trimmed) line = trimmed;
  }
  return line.replace(/^["'`]+|["'`.]+$/g, "").slice(0, 72);
}

// The panel's settings, restated for the agent so a Magic Stack run names
// branches and writes commits the way the composer would. Empty when nothing
// is configured and the agent should follow the repository's own habits.
function conventionsLines(settings: Settings, detectedPrefix: string | null): string[] {
  const lines: string[] = [];
  const prefix = settings.branchPrefix || detectedPrefix;
  if (prefix) {
    lines.push(
      `Name every branch \`${prefix}<slug>\`, matching the prefix this workspace already uses.`,
    );
  }
  if (settings.conventionalCommits) {
    lines.push(
      "Write every commit message and PR title as a Conventional Commit — `type(scope): subject`, type one of feat, fix, docs, refactor, perf, test, build, ci, chore. The scope names the part of the codebase the layer touches (a package, module, or directory name, lower case); omit it when the layer spans several or none fits. Lead each branch slug with the type only, not the scope (`feat(api): add rate limiting` → `feat-add-rate-limiting`).",
    );
  }
  return lines;
}

// How to run a split fast and prove it lossless. Restated on every Magic
// Stack run — without it each agent rediscovers these rules the slow way
// (anchored string edits that drift, partial failures that cannot re-run,
// a top of stack nobody verified).
function splitProtocolLines(): string[] {
  return [
    "Before restructuring: `git stash push` any workspace changes that are not part of this work; run the repository's lint and typecheck so you split a clean tree; copy every file you will move to a temporary snapshot directory, and when the stack is built byte-compare the top against that snapshot.",
    "If the work already exists as per-concern commits, build each layer by cherry-picking them — never re-edit files a commit already captures.",
    "When splitting a mixed tree, assign whole files to the single layer that owns them, and for a file two layers share write out its full intermediate state per layer — byte-exact copies, not patches or anchored string edits, which drift and cannot safely re-run. If the repository has a splitter tool (for example `bun scripts/split-layers.ts <manifest>`), drive it with a manifest instead of editing by hand.",
    "Prove every layer stands alone, not just the top one: give the splitter a `verify` command that runs the repository's typecheck and tests, or run them yourself before each commit. A layer that only compiles once the layer above lands is not reviewable.",
  ];
}

function magicCreatePrompt(settings: Settings, detectedPrefix: string | null): string {
  return [
    "Split the work in this workspace into a stack of reviewable branches with `gh stack`. If a `gh-stack` skill is available, follow it; otherwise the steps below are complete on their own.",
    "1. Inspect the state: uncommitted changes plus commits not on the trunk branch.",
    "2. Design the layers bottom-to-top — one dependent concern per layer, with foundational work (types, schema, shared helpers) at the bottom and the code that consumes it above. Each layer must read as one reviewable idea and stand alone; when in doubt prefer fewer, larger layers over many that only make sense together.",
    "3. Create the stack with `gh stack init <branch>` and `gh stack add <branch>`, moving each concern into its owning layer.",
    "4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json` and share the PR links.",
    ...splitProtocolLines(),
    ...conventionsLines(settings, detectedPrefix),
    "If the work is a single indivisible concern, say so and create a one-layer stack instead of forcing a split.",
  ].join("\n");
}

// Same idea on a workspace that already has a stack: extend it rather than
// init a new one.
function magicExtendPrompt(settings: Settings, detectedPrefix: string | null): string {
  return [
    "This workspace already has a stack. Split the work that is not yet in it into more layers on top, with `gh stack`. If a `gh-stack` skill is available, follow it; otherwise the steps below are complete on their own.",
    "1. Inspect the state: `gh stack view --json`, plus uncommitted changes and commits not yet in a layer.",
    "2. Design the new layers bottom-to-top — one dependent concern per layer, foundational work below the code that consumes it. Each layer must read as one reviewable idea and stand alone.",
    "3. Run `gh stack top`, then `gh stack add <branch>` per layer, moving each concern into its owning layer. Do not run `gh stack init` while the stack still has a branch to build on; it would start a second stack.",
    "If `gh stack top` fails because the layer branches no longer exist (every layer merged, branches pruned locally and on the remote), there is nothing to extend: build the layers on the trunk instead, then adopt them with `gh stack init --base <trunk> <branch>...`, which reuses those branches rather than creating a competing stack.",
    "4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json` and share the PR links.",
    ...splitProtocolLines(),
    ...conventionsLines(settings, detectedPrefix),
    "If the remaining work belongs in an existing layer, say so and commit it there instead of forcing a new layer.",
  ].join("\n");
}

// Handed to the thread when native `gh stack sync` stops in a state only an
// agent can untangle. Self-contained on purpose: recovery is the most
// destructive path here and must not depend on a skill being installed.
function syncRecoveryPrompt(withSubmit: boolean): string {
  return [
    "Native `gh stack sync` already ran and reported a non-trivial recovery state; it may have partial effects. If a `gh-stack` skill is available, follow it; otherwise use the steps below. Inspect first — do not retry sync yet.",
    "1. `git status`: is a rebase or merge in progress, which files conflict, and what is checked out?",
    "2. If a rebase is in progress, `git rebase --show-current-patch` shows the stopped commit. Resolve and `git rebase --continue`, or `git rebase --abort` to return to the pre-sync state when the right resolution is not obvious.",
    "3. `gh stack view --json`: which layers exist, and where does each branch point?",
    "4. Recover the stack, then verify: clean `git status`, no rebase in progress, and `gh stack view --json` showing every layer on its intended parent.",
    withSubmit
      ? "5. Only after that verification succeeds, run `gh stack submit --auto`, then verify the submitted stack with `gh stack view --json`."
      : "5. Do not run `gh stack submit` as part of this recovery.",
    "Report the state you found, what you changed, and the final `gh stack view --json`. If you cannot recover safely, stop and say what is blocking you — never force-push or delete branches to clear the error.",
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
const DRAFT_INTENT_TTL_MS = 120_000;
// PR title/draft/state, cached per workspace. A hit inside this window skips
// the `gh pr list` entirely; an older entry is still served when the read
// fails, so a rate limit degrades titles to stale rather than to nothing.
const PR_METADATA_FRESH_MS = 60_000;
// How long a failed read may keep serving the last good values before the
// panel shows state-only rows instead.
const PR_METADATA_MAX_AGE_MS = 30 * 60_000;

export default async function plugin(bb: BbPluginApi) {
  // Per-thread cache of the last computed getStack payload; lastReadAt is the
  // watched-thread signal for the idle-event refresh.
  const stackCache = new Map<
    string,
    {
      payload: StackPayload;
      fetchedAt: number;
      lastReadAt: number;
    }
  >();
  // One compute per thread at a time: concurrent callers share the promise.
  const stackInflight = new Map<string, Promise<StackPayload>>();
  const threadWorkspaceKeys = new Map<string, string>();
  const stackComputeWorkspaceState = new Map<string, { key: string; mutationVersion: number }>();
  const workspaceMutationVersions = new Map<string, number>();
  // gh-stack's own lock covers only metadata persistence. This guard covers
  // the full checkout/rebase/push/PR operation and rejects overlap rather
  // than letting two BB panels mutate one repository concurrently.
  const activeWorkspaceMutations = new Set<string>();
  // A handled stash apply is also recorded durably. Keep its OID blocked in
  // memory as a fail-safe if that state write only partly succeeds.
  const blockedAutoStashOids = new Set<string>();
  const remoteRefreshAt = new Map<string, number>();
  const remoteRefreshInflight = new Map<string, Promise<boolean>>();
  // workspaceKey -> prNumber -> last successful read. Survives a failed
  // refresh so the panel keeps showing titles it has already seen.
  const prMetadataCache = new Map<string, PrMetadataCache>();
  const draftIntents = new Map<string, { draft: boolean; at: number }>();
  const syncHandoffAt = new Map<string, number>();
  const recoveryLeases = new Map<
    string,
    { workspaceKey: string; threadId: string; intent: string; expiresAt: number }
  >();

  function activeRecoveryLease(workspaceKey: string) {
    const lease = recoveryLeases.get(workspaceKey);
    if (lease && lease.expiresAt <= Date.now()) {
      recoveryLeases.delete(workspaceKey);
      syncHandoffAt.delete(`${workspaceKey}\0${lease.intent}`);
      return null;
    }
    return lease ?? null;
  }

  function clearRecoveryForThread(threadId: string): void {
    for (const [workspaceKey, lease] of recoveryLeases) {
      if (lease.threadId !== threadId) continue;
      recoveryLeases.delete(workspaceKey);
      syncHandoffAt.delete(`${workspaceKey}\0${lease.intent}`);
    }
  }

  function refreshRemoteRefs(workspace: ValidWorkspace): Promise<boolean> {
    if (activeWorkspaceMutations.has(workspace.key) || activeRecoveryLease(workspace.key)) {
      return Promise.resolve(false);
    }
    if (Date.now() - (remoteRefreshAt.get(workspace.key) ?? 0) <= REMOTE_FETCH_FRESH_MS) {
      return Promise.resolve(true);
    }
    const existing = remoteRefreshInflight.get(workspace.key);
    if (existing) return existing;

    let resolveRefresh!: (successful: boolean) => void;
    const reservation = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    // Reserve before starting any asynchronous work so mutations cannot race
    // the fetch and computes for other threads in this workspace join it.
    remoteRefreshInflight.set(workspace.key, reservation);
    void (async () => {
      let successful = false;
      try {
        if (!activeWorkspaceMutations.has(workspace.key)) {
          const fetch = await runGit(["fetch", "--quiet", "origin"], workspace.cwd, 20_000);
          successful = fetch.code === 0;
          if (successful) remoteRefreshAt.set(workspace.key, Date.now());
        }
      } finally {
        remoteRefreshInflight.delete(workspace.key);
        resolveRefresh(successful);
      }
    })();
    return reservation;
  }

  // Enrichment for one stack's PRs: cache first, one `gh pr list` for the
  // rest. Entries are stamped per PR, so a failed read keeps serving the last
  // good values (flagged stale) rather than collapsing rows to branch names.
  async function enrichPrs(
    workspaceKey: string,
    cwd: string,
    numbers: number[],
  ): Promise<Map<number, PrMetadataResolution>> {
    if (numbers.length === 0) return new Map();
    let cached = prMetadataCache.get(workspaceKey);
    if (!cached) {
      cached = new Map();
      prMetadataCache.set(workspaceKey, cached);
    }
    const { hits, missing } = partitionPrMetadata(
      cached,
      numbers,
      Date.now(),
      PR_METADATA_FRESH_MS,
    );
    if (missing.length === 0) return hits;
    const fetched = await readPrMetadata(cwd, missing);
    const resolved = applyPrMetadataReads(
      cached,
      missing,
      fetched,
      Date.now(),
      PR_METADATA_MAX_AGE_MS,
    );
    // Numbers that left the stack should not pin memory. Sweep only when the
    // cache has clearly outgrown the stack, so an ordinary compute does not
    // discard entries a concurrent one just read.
    if (cached.size > numbers.length * 4) evictAbsentPrMetadata(cached, numbers);
    for (const [number, entry] of resolved) hits.set(number, entry);
    return hits;
  }

  const draftIntentKey = (workspaceKey: string, prNumber: number) => `${workspaceKey}\0${prNumber}`;

  function applyDraftIntents(threadId: string, payload: StackPayload): StackPayload {
    const now = Date.now();
    for (const [key, intent] of draftIntents) {
      if (now - intent.at > DRAFT_INTENT_TTL_MS) draftIntents.delete(key);
    }
    const workspaceKey = threadWorkspaceKeys.get(threadId);
    if (!workspaceKey || !payload.stack) return payload;
    let changed = false;
    const branches = payload.stack.branches.map((branch) => {
      if (!branch.pr) return branch;
      const key = draftIntentKey(workspaceKey, branch.pr.number);
      const intent = draftIntents.get(key);
      if (!intent) return branch;
      if (branch.pr.isDraft === intent.draft) {
        draftIntents.delete(key);
        return branch;
      }
      changed = true;
      return {
        ...branch,
        pr: { ...branch.pr, isDraft: intent.draft },
        draftReconciliationPending: true,
      };
    });
    return changed ? { ...payload, stack: { ...payload.stack, branches } } : payload;
  }

  function publishWorkspace(workspaceKey: string): void {
    for (const [threadId, key] of threadWorkspaceKeys) {
      if (key !== workspaceKey) continue;
      const fetchedAt = stackCache.get(threadId)?.fetchedAt ?? Date.now();
      bb.realtime.publish("stack-updated", { threadId, fetchedAt });
    }
  }

  // The settings popup writes one global kv row; it is read on every compute,
  // so keep the parsed value in memory and refresh it on save.
  const SETTINGS_KEY = "settings";
  let settingsCache: Settings | null = null;

  async function loadSettings(): Promise<Settings> {
    if (settingsCache) return settingsCache;
    const parsed = settingsSchema.safeParse(await bb.storage.kv.get<unknown>(SETTINGS_KEY));
    settingsCache = parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
    return settingsCache;
  }

  // The branch the panel would have previewed for this layer name — same
  // rule, including the fall back to the workspace's own namespace when no
  // prefix is configured.
  async function deriveWithSettings(threadId: string, name: string): Promise<string> {
    const settings = await loadSettings();
    const slug = deriveBranchName(name, settings.conventionalCommits);
    if (!slug) return "";
    const prefix =
      settings.branchPrefix || stackCache.get(threadId)?.payload.detectedBranchPrefix || "";
    return `${prefix}${slug}`;
  }

  // Waiters for hidden helper threads (Suggest): resolved by the idle/failed
  // lifecycle events below.
  const idleWaiters = new Map<string, (text: string | null) => void>();
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    clearRecoveryForThread(thread.id);
    const waiter = idleWaiters.get(thread.id);
    if (waiter) {
      idleWaiters.delete(thread.id);
      waiter(lastAssistantText);
    }
    // The agent just finished a turn — the workspace likely changed. Refresh
    // watched threads so open panels update without a manual Refresh. Skip
    // when the cache is seconds old: back-to-back idle events would each pay
    // the full gh cost for a result that already includes the change. A
    // checkout deferred while the thread was running retries immediately.
    const entry = stackCache.get(thread.id);
    if (
      entry &&
      Date.now() - entry.lastReadAt < STACK_WATCH_MS &&
      (entry.payload.checkoutWarning !== null ||
        Date.now() - entry.fetchedAt > STACK_IDLE_COALESCE_MS)
    ) {
      refreshStackInBackground(thread.id);
    }
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    clearRecoveryForThread(thread.id);
    stackCache.delete(thread.id);
    threadWorkspaceKeys.delete(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    clearRecoveryForThread(thread.id);
    const waiter = idleWaiters.get(thread.id);
    if (waiter) {
      idleWaiters.delete(thread.id);
      waiter(null);
    }
  });

  function waitForIdle(threadId: string, timeoutMs: number): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout>;
    const idle = new Promise<string | null>((resolve) => {
      idleWaiters.set(threadId, resolve);
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return Promise.race([idle, timeout]).finally(() => {
      clearTimeout(timer);
      idleWaiters.delete(threadId);
    });
  }

  type Workspace =
    | { cwd: string; key: string; error: null }
    | { cwd: null; key: null; error: { kind: StackErrorKind; message: string } };

  type ValidWorkspace = Extract<Workspace, { error: null }>;

  type StackComputation = {
    payload: StackPayload;
    workspace: ValidWorkspace | null;
    checkout: StackLayerCheckout | null;
  };

  async function resolveWorkspace(threadId: string): Promise<Workspace> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      threadWorkspaceKeys.delete(threadId);
      return {
        cwd: null,
        key: null,
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
      threadWorkspaceKeys.delete(threadId);
      return {
        cwd: null,
        key: null,
        error: {
          kind: "no-environment",
          message: "This thread's environment is not a git workspace.",
        },
      };
    }
    // gh runs on the BB server host; a workspace on a remote machine
    // won't exist here.
    if (!existsSync(environment.path)) {
      threadWorkspaceKeys.delete(threadId);
      return {
        cwd: null,
        key: null,
        error: {
          kind: "workspace-missing",
          message: `Workspace path ${environment.path} does not exist on the BB server host (remote environments are not supported).`,
        },
      };
    }
    const cwd = environment.path;
    const resolvedKey = await resolveWorkspaceKey(cwd, runGit);
    if (resolvedKey.error !== null) {
      threadWorkspaceKeys.delete(threadId);
      return {
        cwd: null,
        key: null,
        error: { kind: "other", message: resolvedKey.error },
      };
    }
    threadWorkspaceKeys.set(threadId, resolvedKey.key);
    return { cwd, key: resolvedKey.key, error: null };
  }

  function invalidateWorkspaceCaches(workspaceKey: string): void {
    const fetchedAt = Date.now();
    // A mutation is exactly what changes titles and draft flags (submit,
    // ready, merge), so the next compute must re-read them rather than serve
    // the pre-mutation copy for the rest of its freshness window.
    prMetadataCache.delete(workspaceKey);
    for (const [cachedThreadId, key] of threadWorkspaceKeys) {
      if (key !== workspaceKey) continue;
      stackCache.delete(cachedThreadId);
      bb.realtime.publish("stack-updated", { threadId: cachedThreadId, fetchedAt });
      // A compute that overlapped this mutation is intentionally not cached.
      // Once it releases the per-thread slot, run a stable post-mutation
      // compute so realtime listeners cannot remain on its stale checkout.
      const inflight = stackInflight.get(cachedThreadId);
      if (inflight) {
        void inflight.then(
          () => refreshStackInBackground(cachedThreadId),
          () => refreshStackInBackground(cachedThreadId),
        );
      }
    }
  }

  async function withWorkspaceMutation(
    workspace: ValidWorkspace,
    operation: () => Promise<ActionResult>,
  ): Promise<ActionResult> {
    if (activeRecoveryLease(workspace.key)) {
      return {
        ok: false,
        message: "Recovery for this repository is already with an agent — watch the conversation.",
        detail: null,
      };
    }
    if (remoteRefreshInflight.has(workspace.key)) {
      return {
        ok: false,
        message:
          "Remote state is refreshing for this repository. Wait for it to finish, then retry.",
        detail: null,
      };
    }
    if (activeWorkspaceMutations.has(workspace.key)) {
      return {
        ok: false,
        message:
          "Another stack operation is already running in this repository. Wait for it to finish, then retry.",
        detail: null,
      };
    }
    activeWorkspaceMutations.add(workspace.key);
    workspaceMutationVersions.set(
      workspace.key,
      (workspaceMutationVersions.get(workspace.key) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      activeWorkspaceMutations.delete(workspace.key);
      workspaceMutationVersions.set(
        workspace.key,
        (workspaceMutationVersions.get(workspace.key) ?? 0) + 1,
      );
      // Failures can still leave partial Git or GitHub side effects.
      invalidateWorkspaceCaches(workspace.key);
    }
  }

  async function reconcileMergedLayerCheckout(
    threadId: string,
    workspace: ValidWorkspace,
    planned: StackLayerCheckout,
  ): Promise<{ recompute: boolean; warning: string | null }> {
    // Another workspace mutation will invalidate this compute when it ends;
    // do not compete with it from a background panel refresh.
    if (activeWorkspaceMutations.has(workspace.key)) {
      return {
        recompute: false,
        warning: `${planned.mergedBranch} was merged and is hidden. Checkout will retry after the current stack operation finishes.`,
      };
    }

    const thread = await bb.sdk.threads.get({ threadId });
    if (
      thread.status === "active" ||
      thread.status === "starting" ||
      thread.status === "stopping"
    ) {
      return {
        recompute: false,
        warning: `${planned.mergedBranch} was merged and is hidden. Checkout will retry when this thread is idle.`,
      };
    }
    const preflightStatus = await runGit(
      ["status", "--porcelain=v1", "-z", "-uall"],
      workspace.cwd,
    );
    if (preflightStatus.code !== 0) {
      return {
        recompute: false,
        warning: `${planned.mergedBranch} was merged and is hidden, but Git could not verify that the working tree is clean. Checkout was deferred.`,
      };
    }
    if (preflightStatus.stdout.length > 0) {
      return {
        recompute: false,
        warning: `${planned.mergedBranch} was merged and is hidden, but checkout stayed there because the working tree has uncommitted changes. Commit or stash them, then refresh.`,
      };
    }
    // The preflight awaits above; a user action may have acquired the
    // workspace in the meantime.
    if (activeWorkspaceMutations.has(workspace.key)) {
      return {
        recompute: false,
        warning: `${planned.mergedBranch} was merged and is hidden. Checkout will retry after the current stack operation finishes.`,
      };
    }

    const outcome = await withWorkspaceMutation(workspace, async () => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        thread.status === "active" ||
        thread.status === "starting" ||
        thread.status === "stopping"
      ) {
        return {
          ok: false,
          message: `${planned.mergedBranch} was merged and is hidden. Checkout will retry when this thread is idle.`,
          detail: null,
        };
      }

      const status = await runGit(["status", "--porcelain=v1", "-z", "-uall"], workspace.cwd);
      if (status.code !== 0) {
        return {
          ok: false,
          message: `${planned.mergedBranch} was merged and is hidden, but Git could not verify that the working tree is clean. Checkout was deferred.`,
          detail: outputTail(status),
        };
      }
      if (status.stdout.length > 0) {
        return {
          ok: false,
          message: `${planned.mergedBranch} was merged and is hidden, but checkout stayed there because the working tree has uncommitted changes. Commit or stash them, then refresh.`,
          detail: null,
        };
      }

      const current = await currentBranchName(workspace.cwd);
      if (current !== planned.mergedBranch) {
        return {
          ok: true,
          message: "Checkout already moved away from the merged layer.",
          detail: null,
        };
      }

      // The plan came from direct per-PR state enrichment, which can be newer
      // than gh stack's best-effort metadata refresh. A merge racing this
      // checkout is picked up by the next panel refresh.
      const target = planned.target;
      const args =
        target.kind === "branch" ? ["stack", "checkout", "--", target.name] : ["stack", "trunk"];
      bb.log.info(`running gh ${args.join(" ")} in ${workspace.cwd}`);
      const result = await runGh(args, workspace.cwd, 30_000);
      const checkedOut = await currentBranchName(workspace.cwd);
      if (checkedOut === target.name) {
        return {
          ok: true,
          message: `Checked out ${target.name} after ${planned.mergedBranch} merged.`,
          detail: outputTail(result),
        };
      }

      const reason =
        result.stderr.trim().split("\n").pop() ||
        `gh ${args.slice(0, 2).join(" ")} exited with code ${result.code}.`;
      return {
        ok: false,
        message: `${planned.mergedBranch} was merged and is hidden, but checkout could not move to ${target.name}: ${reason}`,
        detail: outputTail(result),
      };
    });

    // Entering the mutation guard advances its version even when checkout is
    // safely deferred. Recompute so only a stable post-guard snapshot can be
    // cached by refreshStack.
    return {
      recompute: true,
      warning: outcome.ok ? null : outcome.message,
    };
  }

  // Recompute one thread's stack, cache it, and announce the fresh payload so
  // every open panel refetches. Concurrent calls share one compute.
  function refreshStack(threadId: string): Promise<StackPayload> {
    const inflight = stackInflight.get(threadId);
    if (inflight) return inflight;
    const promise = (async () => {
      let computation = await computeStack(threadId);
      let checkoutWarning: string | null = null;
      if (computation.workspace && computation.checkout) {
        const reconciliation = await reconcileMergedLayerCheckout(
          threadId,
          computation.workspace,
          computation.checkout,
        );
        checkoutWarning = reconciliation.warning;
        if (reconciliation.recompute) {
          computation = await computeStack(threadId);
        }
      }
      return { ...computation.payload, checkoutWarning };
    })()
      .then(async (payload) => {
        // computeStack read the settings when it started; a save landing
        // mid-compute would otherwise be overwritten by that older copy.
        const settings = await loadSettings();
        const stamped: StackPayload = {
          ...payload,
          settings,
          branchPrefix: settings.branchPrefix || payload.detectedBranchPrefix,
        };
        const fetchedAt = Date.now();
        const computeState = stackComputeWorkspaceState.get(threadId);
        const stable =
          !computeState ||
          (!activeWorkspaceMutations.has(computeState.key) &&
            (workspaceMutationVersions.get(computeState.key) ?? 0) ===
              computeState.mutationVersion);
        // A read that overlapped a mutation may contain a mixed checkout/ref
        // snapshot. Return it to its waiter, but never let it repopulate the
        // shared cache; mutation completion announces a stable refetch.
        if (!stable) return stamped;
        // A background recompute is not a read: keep the old lastReadAt.
        const lastReadAt = stackCache.get(threadId)?.lastReadAt ?? 0;
        stackCache.set(threadId, {
          payload: stamped,
          fetchedAt,
          lastReadAt,
        });
        bb.realtime.publish("stack-updated", { threadId, fetchedAt });
        return stamped;
      })
      .finally(() => {
        stackInflight.delete(threadId);
        stackComputeWorkspaceState.delete(threadId);
      });
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

  async function computeStack(threadId: string): Promise<StackComputation> {
    const settings = await loadSettings();
    // A configured prefix wins over whatever the workspace's branches share.
    const effectivePrefix = (detected: string | null): string | null =>
      settings.branchPrefix || detected;
    const workspace = await resolveWorkspace(threadId);
    if (workspace.error) {
      stackComputeWorkspaceState.delete(threadId);
      return {
        payload: {
          stack: null,
          workspacePath: null,
          error: workspace.error,
          checkoutWarning: null,
          pending: null,
          defaultBranch: null,
          branchPrefix: effectivePrefix(null),
          detectedBranchPrefix: null,
          settings,
        },
        workspace: null,
        checkout: null,
      };
    }
    const cwd = workspace.cwd;
    stackComputeWorkspaceState.set(threadId, {
      key: workspace.key,
      mutationVersion: workspaceMutationVersions.get(workspace.key) ?? 0,
    });

    const [result, pending, defaultBranch, headPrefix, stashOwners, stashCounts] =
      await Promise.all([
        runGh(["stack", "view", "--json"], cwd, 30_000),
        pendingChangeSet(cwd),
        defaultBranchName(cwd),
        currentBranchPrefix(cwd),
        activeAutoStashOwners({
          runGit: (args, timeoutMs) => runGit(args, cwd, timeoutMs),
          blockedStashOids: blockedAutoStashOids,
        }),
        stashCountsByBranch({
          runGit: (args, timeoutMs) => runGit(args, cwd, timeoutMs),
        }),
      ]);
    const inspected = parseStackViewResult(result);
    if (inspected.error) {
      return {
        payload: {
          stack: null,
          workspacePath: cwd,
          error: inspected.error,
          checkoutWarning: null,
          pending,
          defaultBranch,
          branchPrefix: effectivePrefix(headPrefix),
          detectedBranchPrefix: headPrefix,
          settings,
        },
        workspace,
        checkout: null,
      };
    }

    // Enrich each branch: PR title + draft status for the whole stack in one
    // batched read, and the diff against its stack parent (the branch below,
    // or the trunk for the bottom branch).
    const rawStack = inspected.stack;
    const rawBranches = rawStack.branches;
    const prMetadata = await enrichPrs(
      workspace.key,
      cwd,
      rawBranches
        .map((branch) => branch.pr?.number)
        .filter((number): number is number => typeof number === "number"),
    );
    // Metrics are advisory, but stale refs must never look clean. A mutation
    // owns the repository, so do not fetch underneath it; report unknown.
    const remoteFresh = await refreshRemoteRefs(workspace);
    const trunkBehindPromise = remoteFresh
      ? revListCount(cwd, rawStack.trunk, `origin/${rawStack.trunk}`)
      : Promise.resolve(null);
    const branches = await Promise.all(
      // oxlint-disable-next-line oxc/no-map-spread -- copy-on-write over zod-parsed data
      rawBranches.map(async (branch, index) => {
        const previous = index === 0 ? null : rawBranches[index - 1];
        if (index > 0 && previous === undefined) {
          throw new Error(`Stack branch ${branch.name} has no parent at index ${index - 1}`);
        }
        const parent = previous?.name ?? rawStack.trunk;
        const diffPromise = branchChangeSet(cwd, parent, branch.name);
        const remote = `refs/remotes/origin/${branch.name}`;
        const remoteExists = remoteFresh
          ? await runGit(["rev-parse", "--verify", "--quiet", remote], cwd)
          : null;
        const remotePresent =
          remoteExists === null
            ? null
            : remoteExists.code === 0
              ? true
              : remoteExists.code === 1
                ? false
                : null;
        const aheadPromise = !remoteFresh
          ? Promise.resolve(null)
          : remotePresent === true
            ? revListCount(cwd, remote, branch.name)
            : remotePresent === false
              ? revListCount(cwd, parent, branch.name)
              : Promise.resolve(null);
        const behindPromise = !remoteFresh
          ? Promise.resolve(null)
          : remotePresent === true
            ? revListCount(cwd, branch.name, remote)
            : remotePresent === false
              ? Promise.resolve(0)
              : Promise.resolve(null);
        if (!branch.pr) {
          return {
            ...branch,
            hasStash: stashOwners?.has(branch.name) ?? false,
            stashCount: stashCounts?.get(branch.name) ?? (stashCounts ? 0 : null),
            pr: null,
            diff: await diffPromise,
            aheadOfRemote: await aheadPromise,
            behindRemote: await behindPromise,
          };
        }
        const enriched = prMetadata.get(branch.pr.number);
        let title: string | null = null;
        let isDraft = false;
        let state = branch.pr.state;
        let isMerged = branch.isMerged || branch.pr.state === "MERGED";
        if (enriched) {
          title = enriched.data.title;
          isDraft = enriched.data.isDraft;
          // Preserve gh-stack's queued state while GitHub still calls the
          // PR open, but correct its false OPEN for closed/merged PRs.
          if (enriched.data.state === "CLOSED" || enriched.data.state === "MERGED") {
            state = enriched.data.state;
            if (enriched.data.state === "MERGED") isMerged = true;
          }
        }
        return {
          ...branch,
          isMerged,
          hasStash: stashOwners?.has(branch.name) ?? false,
          stashCount: stashCounts?.get(branch.name) ?? (stashCounts ? 0 : null),
          pr: {
            ...branch.pr,
            state,
            title,
            isDraft,
            // No metadata at all, or values kept from an older read.
            metadataStale: !enriched || enriched.stale,
          },
          diff: await diffPromise,
          aheadOfRemote: await aheadPromise,
          behindRemote: await behindPromise,
        };
      }),
    );
    // The stack's own namespace wins over the checked-out branch's.
    const detected = branchPrefixOf(branches.map((branch) => branch.name)) ?? headPrefix;
    const projected = projectStackLayers(branches, rawStack.trunk, rawStack.currentBranch);
    // Direct PR state can be newer than gh stack's metadata. Count only after
    // enrichment, while leaving merged rows hidden from the branch payload.
    const pruneProbes = await Promise.all(
      pruneCandidates(branches).map((branch) => localBranchExists(cwd, branch)),
    );
    const prunableBranchCount = pruneProbes.some((exists) => exists === null)
      ? null
      : pruneProbes.filter((exists) => exists).length;
    return {
      payload: {
        stack: {
          ...rawStack,
          branches: projected.visibleBranches,
          trunkBehind: await trunkBehindPromise,
          prunableBranchCount,
        },
        workspacePath: cwd,
        error: null,
        checkoutWarning: null,
        pending,
        defaultBranch,
        branchPrefix: effectivePrefix(detected),
        detectedBranchPrefix: detected,
        settings,
      },
      workspace,
      checkout: projected.checkout,
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
        return { ...applyDraftIntents(threadId, cached.payload), fetchedAt: cached.fetchedAt };
      }
      // An explicit Refresh is the user asking GitHub again — usually because
      // what the panel shows looks wrong — so it re-reads PR metadata instead
      // of serving the rest of that cache window.
      const workspaceKey = threadWorkspaceKeys.get(threadId);
      if (workspaceKey) prMetadataCache.delete(workspaceKey);
      let payload = await refreshStack(threadId);
      let entry = stackCache.get(threadId);
      // An explicit refresh may have joined a compute that overlapped a
      // workspace mutation. Such payloads are deliberately not cached; wait
      // for one stable retry instead of stamping and returning stale state.
      if (refresh === true && !entry) {
        payload = await refreshStack(threadId);
        entry = stackCache.get(threadId);
      }
      if (entry) entry.lastReadAt = Date.now();
      return {
        ...applyDraftIntents(threadId, payload),
        fetchedAt: entry?.fetchedAt ?? Date.now(),
      };
    },

    async checkoutBranch({ threadId, branch }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      return withWorkspaceMutation(workspace, async () => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (
          thread.status === "active" ||
          thread.status === "starting" ||
          thread.status === "stopping"
        ) {
          return {
            ok: false,
            message: "Wait for this thread to become idle before checking out another stack layer.",
            detail: null,
          };
        }

        const cwd = workspace.cwd;
        const view = await readStackView(cwd);
        if (view.error) {
          return { ok: false, message: view.error.message, detail: null };
        }
        const target = view.stack.branches.find((candidate) => candidate.name === branch);
        if (!target) {
          return {
            ok: false,
            message: `${branch} is not in the current stack anymore. Refresh the panel.`,
            detail: null,
          };
        }
        if (target.isMerged || target.pr?.state === "MERGED") {
          return {
            ok: false,
            message: `${branch} is merged and no longer available in the stack panel.`,
            detail: null,
          };
        }
        if (target.pr) {
          const direct = await readPullRequestState(cwd, target.pr.number);
          if (!direct.state) {
            return {
              ok: false,
              message: `Could not verify whether ${branch} is still available: ${direct.error}`,
              detail: direct.detail,
            };
          }
          if (direct.state.headRefName !== branch) {
            return {
              ok: false,
              message: `PR #${target.pr.number} points to ${direct.state.headRefName}, not ${branch}. Refresh the panel.`,
              detail: direct.detail,
            };
          }
          if (direct.state.state === "MERGED") {
            return {
              ok: false,
              message: `${branch} is merged and no longer available in the stack panel.`,
              detail: direct.detail,
            };
          }
        }

        const current = await currentBranchName(cwd);
        if (current === branch) {
          return { ok: true, message: `Already on ${branch}.`, detail: null };
        }

        // Validation above may await GitHub. Recheck immediately before the
        // mutation so an agent cannot start working underneath the checkout.
        const latestThread = await bb.sdk.threads.get({ threadId });
        if (
          latestThread.status === "active" ||
          latestThread.status === "starting" ||
          latestThread.status === "stopping"
        ) {
          return {
            ok: false,
            message: "Wait for this thread to become idle before checking out another stack layer.",
            detail: null,
          };
        }

        return checkoutWithAutoStash(branch, {
          runGit: (args, timeoutMs) => runGit(args, cwd, timeoutMs),
          checkout: (targetBranch) => {
            const args = ["stack", "checkout", "--", targetBranch];
            bb.log.info(`running gh ${args.join(" ")} in ${cwd}`);
            return runGh(args, cwd, 30_000);
          },
          currentBranch: () => currentBranchName(cwd),
          blockedStashOids: blockedAutoStashOids,
        });
      });
    },

    async setPrDraft({ threadId, prNumber, draft }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;
      // No workspace mutation lock: `gh pr ready` talks to GitHub and never
      // touches the working tree, so any number of toggles run concurrently —
      // with each other, and with reads. Stack membership is checked against
      // the cached payload (one fresh view only when the cache is cold)
      // instead of paying a full `gh stack view` per click.
      let ownerName =
        stackCache
          .get(threadId)
          ?.payload.stack?.branches.find((branch) => branch.pr?.number === prNumber)?.name ?? null;
      if (ownerName === null) {
        const view = await readStackView(cwd);
        if (view.error) {
          return { ok: false, message: view.error.message, detail: null };
        }
        ownerName =
          view.stack.branches.find((branch) => branch.pr?.number === prNumber)?.name ?? null;
      }
      if (ownerName === null) {
        return {
          ok: false,
          message: `PR #${prNumber} is not an open pull request in the current stack.`,
          detail: null,
        };
      }
      const before = await readPullRequestState(cwd, prNumber);
      if (!before.state) {
        return { ok: false, message: before.error, detail: before.detail };
      }
      if (before.state.headRefName !== ownerName) {
        return {
          ok: false,
          message: `PR #${prNumber} points to ${before.state.headRefName}, not stack branch ${ownerName}.`,
          detail: before.detail,
        };
      }
      if (before.state.state !== "OPEN") {
        return {
          ok: false,
          message: `PR #${prNumber} is ${before.state.state.toLowerCase()} and cannot change review readiness.`,
          detail: before.detail,
        };
      }
      if (before.state.isDraft === draft) {
        return {
          ok: false,
          message: `PR #${prNumber} is already ${draft ? "a draft" : "ready for review"}.`,
          detail: before.detail,
        };
      }

      // Claim the new state before the command runs: a payload served while
      // gh is still working would otherwise show the old pill everywhere.
      const intentKey = draftIntentKey(workspace.key, prNumber);
      draftIntents.set(intentKey, { draft, at: Date.now() });
      publishWorkspace(workspace.key);
      const args = draft
        ? ["pr", "ready", String(prNumber), "--undo"]
        : ["pr", "ready", String(prNumber)];
      bb.log.info(`running gh ${args.join(" ")} in ${cwd}`);
      const result = await runGh(args, cwd, 30_000);
      const detail = outputTail(result);
      if (result.failedToSpawn || result.timedOut || result.code !== 0) {
        // The write never landed — drop the claim and announce, so the pill
        // reverts to what GitHub reports instead of holding a state that
        // does not exist.
        draftIntents.delete(intentKey);
        publishWorkspace(workspace.key);
        const reason = result.stderr.trim().split("\n").pop() ?? "";
        return {
          ok: false,
          message: reason || `gh pr ready exited with code ${result.code}.`,
          detail,
        };
      }
      const after = await readPullRequestState(cwd, prNumber);
      if (after.state?.isDraft === draft) draftIntents.delete(intentKey);
      // Patch the PR-metadata cache so a compute inside its freshness window
      // serves the post-toggle value rather than a pre-toggle read.
      const metadata = prMetadataCache.get(workspace.key);
      const metadataEntry = metadata?.get(prNumber);
      if (metadata && metadataEntry) {
        metadata.set(prNumber, {
          data: {
            ...metadataEntry.data,
            isDraft: after.state?.isDraft ?? draft,
          },
          at: Date.now(),
        });
      }
      // Converge in the background: the overlay carries the pill until a
      // compute comes back agreeing, which retires it. A compute already in
      // flight started before this write landed and cannot contain it —
      // chain one more behind it instead of joining it, or the overlay would
      // wait out its TTL on a payload that predates the toggle.
      const inflight = stackInflight.get(threadId);
      if (inflight) {
        const rerun = () => refreshStackInBackground(threadId);
        void inflight.then(rerun, rerun);
      } else {
        refreshStackInBackground(threadId);
      }
      if (!after.state) {
        return {
          ok: true,
          message: `GitHub accepted the change for PR #${prNumber}; its read model is still catching up.`,
          detail: joinDetails(detail, after.detail),
        };
      }
      return {
        ok: true,
        message: draft
          ? `PR #${prNumber} converted to draft.`
          : `PR #${prNumber} marked ready for review.`,
        detail,
      };
    },

    async runAction({ threadId, action }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        thread.status === "active" ||
        thread.status === "starting" ||
        thread.status === "stopping"
      ) {
        return {
          ok: false,
          message: "Wait for this thread's agent to become idle before changing the stack.",
          detail: null,
        };
      }
      const handoffKey = `${workspace.key}\0${action}`;
      if (Date.now() - (syncHandoffAt.get(handoffKey) ?? 0) < 600_000) {
        return {
          ok: false,
          message: "This recovery is already with the thread's agent — watch the conversation.",
          tone: "warning" as const,
          detail: null,
        };
      }
      return withWorkspaceMutation(workspace, async () => {
        const cwd = workspace.cwd;
        let prunePreflight: { candidates: string[]; protected: string[] } | null = null;

        if (action === "prune") {
          const before = await readStackView(cwd);
          if (before.error) {
            return { ok: false, message: before.error.message, detail: null };
          }

          const corrected = [];
          for (const branch of before.stack.branches) {
            if (!branch.pr) {
              corrected.push(branch);
              continue;
            }
            const direct = await readPullRequestState(cwd, branch.pr.number);
            if (!direct.state || direct.state.headRefName !== branch.name) {
              return {
                ok: false,
                message: `Prune stopped because PR state could not be verified for ${branch.name}.`,
                detail: direct.detail,
              };
            }
            corrected.push({
              ...branch,
              isMerged: branch.isMerged || direct.state.state === "MERGED",
              pr: {
                ...branch.pr,
                state:
                  branch.pr.state === "MERGED" || branch.isMerged ? "MERGED" : direct.state.state,
              },
            });
          }

          const candidateNames = pruneCandidates(corrected);
          const probes = await Promise.all(
            candidateNames.map((branch) => localBranchExists(cwd, branch)),
          );
          if (probes.some((exists) => exists === null)) {
            return {
              ok: false,
              message: "Prune stopped because a candidate local ref could not be verified.",
              detail: null,
            };
          }
          const candidates = candidateNames.filter((_, index) => probes[index] === true);
          if (candidates.length === 0) {
            return {
              ok: false,
              message: "There are no merged local branches to prune.",
              detail: null,
            };
          }
          if (before.stack.currentBranch && candidates.includes(before.stack.currentBranch)) {
            return {
              ok: false,
              message: "Check out an unmerged branch before pruning the current merged branch.",
              detail: null,
            };
          }
          const allLocal = await localBranchNames(cwd);
          if (!allLocal) {
            return {
              ok: false,
              message: "Prune stopped because existing local branches could not be recorded.",
              detail: null,
            };
          }
          prunePreflight = {
            candidates,
            protected: allLocal.filter((branch) => !candidates.includes(branch)),
          };
        }

        const verify = async (intent: "sync" | "submit", detail: string | null) => {
          const view = await readStackView(cwd);
          if (view.error) {
            return {
              ok: false,
              message: `${intent} completed, but verification failed: ${view.error.message}`,
              tone: "warning" as const,
              detail,
            };
          }
          const active = view.stack.branches.filter(
            (branch) =>
              !branch.isMerged &&
              !branch.isQueued &&
              branch.pr?.state !== "MERGED" &&
              branch.pr?.state !== "QUEUED",
          );
          const unpushed = await branchesNotAtUpstream(
            cwd,
            active.map((branch) => branch.name),
          );
          if (unpushed.length > 0) {
            return {
              ok: false,
              message: `${intent} completed, but branches do not match upstream: ${unpushed.join(", ")}.`,
              tone: "warning" as const,
              detail,
            };
          }
          if (intent === "sync") {
            const stale = active.filter((branch) => branch.needsRebase);
            if (stale.length > 0) {
              return {
                ok: false,
                message: `Sync completed, but these active branches still need a rebase: ${stale.map((branch) => branch.name).join(", ")}.`,
                tone: "warning" as const,
                detail,
              };
            }
          }
          if (intent === "submit") {
            for (const branch of active) {
              if (!branch.pr) {
                return {
                  ok: false,
                  message: `Submit completed, but no PR was verified for ${branch.name}.`,
                  tone: "warning" as const,
                  detail,
                };
              }
              const direct = await readPullRequestState(cwd, branch.pr.number);
              if (
                !direct.state ||
                direct.state.state !== "OPEN" ||
                direct.state.headRefName !== branch.name
              ) {
                return {
                  ok: false,
                  message: `Submit completed, but a matching open PR was not verified for ${branch.name}.`,
                  tone: "warning" as const,
                  detail: joinDetails(detail, direct.detail),
                };
              }
            }
          }
          return { ok: true, message: "", detail };
        };

        const steps: Array<"sync" | "submit" | "prune"> =
          action === "sync-submit" ? ["sync", "submit"] : [action];
        let detail: string | null = null;
        for (const step of steps) {
          const args =
            step === "submit"
              ? ["stack", "submit", "--auto"]
              : step === "prune"
                ? ["stack", "sync", "--prune"]
                : ["stack", "sync"];
          bb.log.info(`running gh ${args.join(" ")} in ${cwd}`);
          const result = await runGh(args, cwd, 180_000);
          detail = joinDetails(detail, outputTail(result));
          const warning = partialSuccessWarning(
            step === "prune" ? "sync" : step,
            result.stdout,
            result.stderr,
          );
          if (step !== "prune" && (result.code !== 0 || warning)) {
            const mapped = mapExitCode(result);
            const needsAgent =
              !result.failedToSpawn &&
              !result.timedOut &&
              requiresAgentSyncRecovery(result.code, result.stdout, result.stderr);
            if (step === "sync" && action !== "prune" && needsAgent) {
              const lease = {
                workspaceKey: workspace.key,
                threadId,
                intent: action,
                expiresAt: Date.now() + 600_000,
              };
              recoveryLeases.set(workspace.key, lease);
              syncHandoffAt.set(handoffKey, Date.now());
              try {
                await bb.sdk.threads.send({
                  threadId,
                  mode: "auto",
                  input: [
                    {
                      type: "text",
                      mentions: [],
                      text: syncRecoveryPrompt(action === "sync-submit"),
                    },
                  ],
                });
                return {
                  ok: false,
                  message: "Agent recovery started. Sync is not complete yet.",
                  tone: "warning" as const,
                  detail,
                };
              } catch (error: unknown) {
                const reason = error instanceof Error ? error.message : String(error);
                if (recoveryLeases.get(workspace.key) === lease) {
                  recoveryLeases.delete(workspace.key);
                }
                syncHandoffAt.delete(handoffKey);
                bb.log.warn(`sync handoff failed: ${reason}`);
                return {
                  ok: false,
                  message:
                    "Sync needs agent recovery, but the agent could not be started. Retry Sync when the thread is idle.",
                  tone: "error" as const,
                  detail: joinDetails(detail, `Agent handoff failed: ${reason}`),
                };
              }
            }
            const failure = warning ?? mapped.message;
            return {
              ok: false,
              message: `${failure}${steps.length > 1 && step === "sync" ? " Submit was not run." : ""}`,
              tone: warning ? ("warning" as const) : ("error" as const),
              detail,
            };
          }
          if (step === "prune") {
            const preflight = prunePreflight!;
            const [candidateProbes, protectedProbes] = await Promise.all([
              Promise.all(preflight.candidates.map((branch) => localBranchExists(cwd, branch))),
              Promise.all(preflight.protected.map((branch) => localBranchExists(cwd, branch))),
            ]);
            const remaining = preflight.candidates.filter(
              (_, index) => candidateProbes[index] !== false,
            );
            const missing = preflight.protected.filter(
              (_, index) => protectedProbes[index] !== true,
            );
            const postconditionDamage =
              remaining.length > 0 || missing.length > 0
                ? `Prune postcondition damage: remaining candidates: ${remaining.join(", ") || "none"}; unexpectedly missing protected refs: ${missing.join(", ") || "none"}.`
                : null;
            if (result.code !== 0 || warning) {
              const primary = warning ?? mapExitCode(result).message;
              return {
                ok: false,
                message: postconditionDamage ? `${primary} ${postconditionDamage}` : primary,
                tone: warning && !postconditionDamage ? ("warning" as const) : ("error" as const),
                detail: joinDetails(detail, postconditionDamage),
              };
            }
            if (remaining.length > 0 || missing.length > 0) {
              return {
                ok: false,
                message: `Prune verification failed. Remaining candidates: ${remaining.join(", ") || "none"}. Unexpectedly missing protected refs: ${missing.join(", ") || "none"}.`,
                tone: missing.length > 0 ? ("error" as const) : ("warning" as const),
                detail,
              };
            }
          } else {
            const checked = await verify(step, detail);
            if (!checked.ok) {
              return {
                ...checked,
                message: `${checked.message}${steps.length > 1 && step === "sync" ? " Submit was not run." : ""}`,
              };
            }
          }
        }
        syncHandoffAt.delete(`${workspace.key}\0${action}`);
        const pruned = prunePreflight?.candidates.length ?? 0;
        const message =
          action === "sync"
            ? "Stack sync verified."
            : action === "submit"
              ? "Stack submit verified."
              : action === "prune"
                ? `Pruned ${pruned} merged local branch${pruned === 1 ? "" : "es"}.`
                : "Stack sync and submit verified in order.";
        return { ok: true, message, detail };
      });
    },

    async mergeStack({ threadId, method, throughPrNumber }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) return { ok: false, message: workspace.error.message, detail: null };
      return withWorkspaceMutation(workspace, async () => {
        const cwd = workspace.cwd;
        const raw = await readStackView(cwd);
        if (raw.error) return { ok: false, message: raw.error.message, detail: null };
        // GitHub is authoritative for terminal state. Preserve gh stack's
        // QUEUED state while GitHub still reports OPEN.
        const enriched = await Promise.all(
          raw.stack.branches.map(async (branch) => {
            if (!branch.pr) return { ...branch, pr: null };
            const direct = await runGh(
              [
                "pr",
                "view",
                String(branch.pr.number),
                "--json",
                "state,isDraft,headRefName,baseRefName,mergedAt",
              ],
              cwd,
              20_000,
            );
            let parsed: z.infer<typeof mergeValidationSchema> | null = null;
            try {
              const checked = mergeValidationSchema.safeParse(JSON.parse(direct.stdout));
              parsed = checked.success ? checked.data : null;
            } catch {
              // Malformed direct state fails eligibility without throwing.
            }
            if (direct.code !== 0 || !parsed) {
              return { ...branch, pr: { ...branch.pr, isDraft: true } };
            }
            const state =
              parsed.state === "CLOSED" || parsed.state === "MERGED"
                ? parsed.state
                : branch.pr.state;
            return {
              ...branch,
              isMerged: parsed.state === "MERGED",
              pr: { ...branch.pr, state, isDraft: parsed.isDraft },
            };
          }),
        );
        const prefix = mergePrefix(enriched, throughPrNumber);
        if (!prefix.pinned || prefix.selected.length === 0) {
          return {
            ok: false,
            message:
              "No contiguous eligible merge prefix matches that request. A closed, draft, merged, missing, or unqueued PR blocks it.",
            detail: null,
          };
        }

        // Recompute and authorize directly immediately before the irreversible request.
        const fresh = await readStackView(cwd);
        if (fresh.error) return { ok: false, message: fresh.error.message, detail: null };
        let expectedBase = fresh.stack.trunk;
        for (const selected of prefix.selected) {
          const stackBranch = fresh.stack.branches.find(
            (branch) => branch.name === selected.name && branch.pr?.number === selected.pr?.number,
          );
          if (!stackBranch?.pr) {
            return {
              ok: false,
              message: `${selected.name} changed before merge; refresh and retry.`,
              detail: null,
            };
          }
          const direct = await runGh(
            [
              "pr",
              "view",
              String(stackBranch.pr.number),
              "--json",
              "state,isDraft,headRefName,baseRefName,mergedAt",
            ],
            cwd,
            20_000,
          );
          let state: z.infer<typeof mergeValidationSchema>;
          try {
            state = mergeValidationSchema.parse(JSON.parse(direct.stdout));
          } catch {
            return {
              ok: false,
              message: `Could not authorize PR #${stackBranch.pr.number}.`,
              detail: outputTail(direct),
            };
          }
          const authorized =
            direct.code === 0 &&
            state.headRefName === selected.name &&
            state.baseRefName === expectedBase &&
            !state.isDraft &&
            !state.mergedAt &&
            (state.state === "OPEN" || state.state === "QUEUED");
          if (!authorized) {
            return {
              ok: false,
              message: `PR #${stackBranch.pr.number} no longer has the expected open/queued head and base chain.`,
              detail: null,
            };
          }
          expectedBase = selected.name;
        }
        const top = prefix.selected.at(-1)?.pr;
        if (!top) {
          return { ok: false, message: "No pull request is eligible to merge.", detail: null };
        }
        const submit = await runGh(stackMergeArgs(top.number, method), cwd, 300_000);
        const detail = outputTail(submit);
        if (submit.timedOut) {
          return {
            ok: false,
            message:
              "The stack merge command timed out. Its final outcome is uncertain; refresh to reconcile.",
            tone: "warning" as const,
            detail,
          };
        }
        if (submit.code !== 0) {
          return {
            ok: false,
            message: `Nothing was merged. ${mapExitCode(submit).message}`,
            detail,
          };
        }
        const count = prefix.selected.length;
        const left =
          enriched.filter((branch) => !branch.isMerged && branch.pr?.state !== "MERGED").length -
          count;
        const rest =
          left > 0
            ? ` The ${left} layer${left === 1 ? "" : "s"} above stay open — run Sync to restack ${left === 1 ? "it" : "them"} onto ${raw.stack.trunk}.`
            : "";
        if (stackMergeWasQueued(submit.stdout, submit.stderr)) {
          return {
            ok: true,
            message: `${count} pull request${count === 1 ? "" : "s"} added to the merge queue on ${raw.stack.trunk}; they land as the queue processes them.${rest}`,
            tone: "warning" as const,
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
          message: `Merged ${count} branch${count === 1 ? "" : "es"} into ${raw.stack.trunk} — ${shape}.${rest}`,
          detail,
        };
      });
    },

    async createStack({ threadId, name, branch: requested }) {
      // The panel sends the branch it previewed; deriving here is the
      // fallback for callers that only pass a name.
      const branch = requested ?? (await deriveWithSettings(threadId, name));
      if (!branch || !isBranchCandidate(branch)) {
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
      return withWorkspaceMutation(workspace, async () => {
        const cwd = workspace.cwd;
        const invalid = await validateBranchRef(cwd, branch);
        if (invalid) return { ok: false, message: invalid, detail: null };

        bb.log.info(`running gh stack init ${branch} in ${cwd}`);
        const result = await runGh(["stack", "init", branch], cwd, 60_000);
        const detail = outputTail(result);
        if (result.code !== 0) {
          return { ok: false, message: mapExitCode(result).message, detail };
        }
        const postcondition = await inspectBranchPostcondition(cwd, branch);
        if (!postcondition.complete) {
          return {
            ok: false,
            message: `gh stack init completed, but ${branch} was not verified as the checked-out stack layer. Inspect the workspace before retrying.`,
            detail: joinDetails(
              detail,
              postcondition.error
                ? `Postcondition check: ${postcondition.error}`
                : `Current branch: ${postcondition.currentBranch ?? "detached HEAD"}.`,
            ),
          };
        }
        return {
          ok: true,
          message: `Stack created; ${branch} is checked out.`,
          detail,
        };
      });
    },

    async addBranch({ threadId, name, branch: requested }) {
      const branch = requested ?? (await deriveWithSettings(threadId, name));
      if (!branch || !isBranchCandidate(branch)) {
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
      return withWorkspaceMutation(workspace, async () => {
        const cwd = workspace.cwd;
        const invalid = await validateBranchRef(cwd, branch);
        if (invalid) return { ok: false, message: invalid, detail: null };
        const stackBefore = await readStackView(cwd);
        if (stackBefore.error) {
          return { ok: false, message: stackBefore.error.message, detail: null };
        }
        if (stackBefore.stack.branches.some((candidate) => candidate.name === branch)) {
          return {
            ok: false,
            message: `${branch} is already part of the current stack.`,
            detail: null,
          };
        }
        const [originalBranch, existedBefore] = await Promise.all([
          currentBranchName(cwd),
          localBranchExists(cwd, branch),
        ]);

        async function failAdd(message: string, detail: string | null): Promise<ActionResult> {
          const postcondition = await inspectBranchPostcondition(cwd, branch);
          const requestedBranchChanged =
            postcondition.stackHasBranch ||
            (!existedBefore && postcondition.branchExists) ||
            (postcondition.currentBranch === branch && originalBranch !== branch);
          if (requestedBranchChanged) {
            return {
              ok: false,
              message: `${message} The operation partially changed the workspace; ${postcondition.currentBranch ?? "a detached HEAD"} is currently checked out. Inspect the stack before retrying.`,
              detail: joinDetails(detail, postcondition.error),
            };
          }
          if (originalBranch && postcondition.currentBranch !== originalBranch) {
            const restore = await runGit(["checkout", "--quiet", originalBranch], cwd, 30_000);
            if (restore.code === 0) {
              return {
                ok: false,
                message: `${message} The original branch ${originalBranch} was restored.`,
                detail: joinDetails(detail, outputTail(restore), postcondition.error),
              };
            }
            return {
              ok: false,
              message: `${message} The original branch ${originalBranch} could not be restored; ${postcondition.currentBranch ?? "a detached HEAD"} is currently checked out.`,
              detail: joinDetails(detail, outputTail(restore), postcondition.error),
            };
          }
          return { ok: false, message, detail: joinDetails(detail, postcondition.error) };
        }

        // gh stack add only works from the top branch; navigate there first.
        // Uncommitted changes follow the checkout onto the new branch.
        bb.log.info(`running gh stack top && gh stack add ${branch} in ${cwd}`);
        const top = await runGh(["stack", "top"], cwd, 30_000);
        if (top.failedToSpawn || top.timedOut || top.code !== 0) {
          return failAdd(mapExitCode(top).message, outputTail(top));
        }
        const result = await runGh(["stack", "add", branch], cwd, 60_000);
        const detail = outputTail(result);
        if (result.code !== 0) {
          const message =
            result.code === 5
              ? "gh stack add must run from the top of the stack; navigating there failed."
              : mapExitCode(result).message;
          return failAdd(message, detail);
        }
        const postcondition = await inspectBranchPostcondition(cwd, branch);
        if (!postcondition.complete) {
          return failAdd(
            `gh stack add completed without verifying ${branch} as the new checked-out top layer.`,
            detail,
          );
        }
        return {
          ok: true,
          message: `${branch} stacked on top and checked out; uncommitted changes carried along.`,
          detail,
        };
      });
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

    async magicStack({ threadId }) {
      // Fail early with a clear message when the workspace can't stack at all.
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      // A stack with layers left to build on must be extended, not
      // re-initialized. One whose layers are all merged is finished: its
      // branches are gone, so there is nothing to stack onto and the agent
      // needs the create prompt instead.
      const view = await readStackView(workspace.cwd);
      if (view.error && view.error.kind !== "not-a-stack") {
        return { ok: false, message: view.error.message, detail: null };
      }
      const hasStack = view.stack !== null && hasExtendableLayers(view.stack.branches);
      // Hand the agent the same naming rules the composer follows.
      const settings = await loadSettings();
      const detectedPrefix =
        stackCache.get(threadId)?.payload.detectedBranchPrefix ??
        (await currentBranchPrefix(workspace.cwd));
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: hasStack
              ? magicExtendPrompt(settings, detectedPrefix)
              : magicCreatePrompt(settings, detectedPrefix),
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
      if (normalized.prefix) {
        const invalid = await validateBranchRef(
          process.cwd(),
          `${normalized.prefix}bb-stack-check`,
        );
        if (invalid) {
          return {
            ok: false,
            message:
              "That branch prefix cannot form a valid Git branch name. Avoid empty components, `..`, `.lock`, and components ending in a dot.",
            settings: await loadSettings(),
          };
        }
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
          branchPrefix: next.branchPrefix || entry.payload.detectedBranchPrefix,
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
