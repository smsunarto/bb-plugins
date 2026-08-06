// bb-plugin-gh-stack — stacked-PR visibility and actions for BB threads.
//
// Runs `gh stack` commands in a thread's workspace (server host):
// view --json for the panel, plus sync / submit / init actions.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
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
});

const stackOutSchema = z.object({
  trunk: z.string(),
  currentBranch: z.string().nullable(),
  branches: z.array(branchOutSchema),
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

// Panel settings, edited in the gear popup and stored in the plugin's kv.
// Both are lenient on read so a row written by an older build still loads.
const settingsSchema = z.object({
  // Namespace put in front of every derived branch ("scott/"). Empty means
  // "match the branches already in the workspace" (the detected prefix).
  branchPrefix: z.string().catch(""),
  // Layer names read as Conventional Commits ("feat: add rate limiting"), and
  // the derived branch carries the type ("scott/feat-add-rate-limiting").
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
  // The number GitHub would most likely give the next pull request —
  // one past the highest issue or PR number. A guess: concurrent work
  // in the repository can take it first.
  nextPrNumber: z.number().nullable(),
});

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
  runAction: {
    input: z
      .object({ threadId: z.string(), action: z.enum(["sync", "submit"]) })
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
      return {
        kind: "not-a-stack",
        message:
          "This workspace's branch is not part of a stack. Create one below or run gh stack init <branch>.",
      };
    case 3:
      return {
        kind: "rebase-conflict",
        message:
          "Rebase conflict. Ask the agent to run gh stack rebase, resolve the conflicts, then gh stack rebase --continue.",
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
// → type "feat", subject "add rate limiting". Scope and the breaking "!" are
// dropped — they belong in the title, not in a branch name.
const CONVENTIONAL_HEAD = /^\s*([A-Za-z]+)\s*(?:\([^)]*\))?\s*!?\s*:\s*(.+)$/;

function splitConventional(name: string): { type: string | null; subject: string } {
  const match = CONVENTIONAL_HEAD.exec(name);
  if (!match) return { type: null, subject: name };
  return { type: match[1].toLowerCase(), subject: match[2] };
}

// The stack name is PR-title-like ("Add rate limiting to the API"); the
// branch is a short slug derived from it. Under Conventional Commits the
// name reads "feat: add rate limiting" and the type leads the slug
// ("feat-add-rate-limiting"); a name without a type just slugifies. Keep in
// sync with deriveBranchName in app.tsx (live preview).
function deriveBranchName(name: string, conventional: boolean): string {
  if (!conventional) return slugify(name);
  const { type, subject } = splitConventional(name);
  const slug = slugify(subject);
  if (!slug) return "";
  return type ? `${type}-${slug}` : slug;
}

// A configured prefix is a branch namespace, so it must be a legal ref head
// and end on a separator ("scott" → "scott/"). Empty means "detect it".
function normalizeBranchPrefix(raw: string): { prefix: string } | { error: string } {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (!trimmed) return { prefix: "" };
  if (!BRANCH_NAME.test(trimmed)) {
    return {
      error:
        "A branch prefix must start with a letter or digit and use only letters, digits, and . _ - /",
    };
  }
  return { prefix: /[/_-]$/.test(trimmed) ? trimmed : `${trimmed}/` };
}

function humanizeBranch(branch: string): string {
  const words = branch.replace(/[-_/]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function suggestNamePrompt(conventional: boolean): string {
  return [
    "Inspect the current work in this workspace: uncommitted changes (git status, git diff) and commits not yet on the default branch.",
    conventional
      ? "Then reply with ONLY one Conventional Commits title that describes the work as a whole — `type: subject`, type one of feat, fix, docs, refactor, perf, test, build, ci, chore; subject in imperative mood, lower case, no trailing period; at most 60 characters in total."
      : "Then reply with ONLY one PR-style title that describes the work as a whole — imperative mood, at most 60 characters, no quotes, no trailing period.",
    "Your entire final message must be just the title, nothing else.",
  ].join("\n");
}

function sanitizeTitle(text: string): string {
  const line =
    text
      .trim()
      .split("\n")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop() ?? "";
  return line.replace(/^["'`]+|["'`.]+$/g, "").slice(0, 72);
}

// The panel's settings, restated for the agent so a Magic Stack run names
// branches and writes commits the way the composer would. Empty when nothing
// is configured and the agent should follow the repository's own habits.
function conventionsLines(settings: Settings, detectedPrefix: string | null): string[] {
  const lines: string[] = [];
  const prefix = settings.branchPrefix || detectedPrefix;
  if (prefix) {
    lines.push(`Name every branch \`${prefix}<slug>\`, matching the prefix this workspace already uses.`);
  }
  if (settings.conventionalCommits) {
    lines.push(
      "Write every commit message and PR title as a Conventional Commit (`type: subject`, type one of feat, fix, docs, refactor, perf, test, build, ci, chore), and lead each branch slug with the same type (e.g. `feat-add-rate-limiting`).",
    );
  }
  return lines;
}

function magicCreatePrompt(settings: Settings, detectedPrefix: string | null): string {
  return [
    "Split the work in this workspace into a stack of reviewable branches with `gh stack` (follow the gh-stack skill).",
    "1. Inspect the state: uncommitted changes plus commits not on the trunk branch.",
    "2. Design the layers bottom-to-top — one dependent concern per layer, foundational work at the bottom (read references/stack-design.md if unsure).",
    "3. Create the stack with `gh stack init <branch>` and `gh stack add <branch>`, moving each concern into its owning layer.",
    "4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json` and share the PR links.",
    ...conventionsLines(settings, detectedPrefix),
    "If the work is a single indivisible concern, say so and create a one-layer stack instead of forcing a split.",
  ].join("\n");
}

// Same idea on a workspace that already has a stack: extend it rather than
// init a new one.
function magicExtendPrompt(settings: Settings, detectedPrefix: string | null): string {
  return [
    "This workspace already has a stack. Split the work that is not yet in it into more layers on top, with `gh stack` (follow the gh-stack skill).",
    "1. Inspect the state: `gh stack view --json`, plus uncommitted changes and commits not yet in a layer.",
    "2. Design the new layers bottom-to-top — one dependent concern per layer (read references/stack-design.md if unsure).",
    "3. Run `gh stack top`, then `gh stack add <branch>` per layer, moving each concern into its owning layer. Do not run `gh stack init`; it would start a second stack.",
    "4. Push and open draft PRs with `gh stack submit --auto`, then confirm with `gh stack view --json` and share the PR links.",
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

export default async function plugin(bb: BbPluginApi) {
  // Per-thread cache of the last computed getStack payload; lastReadAt is the
  // watched-thread signal for the idle-event refresh.
  const stackCache = new Map<
    string,
    { payload: StackPayload; fetchedAt: number; lastReadAt: number }
  >();
  // One compute per thread at a time: concurrent callers share the promise.
  const stackInflight = new Map<string, Promise<StackPayload>>();

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
    const prefix =
      settings.branchPrefix ||
      stackCache.get(threadId)?.payload.detectedBranchPrefix ||
      "";
    return `${prefix}${slug}`;
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
      idleWaiters.set(threadId, (text) => {
        clearTimeout(timer);
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
          branchPrefix: settings.branchPrefix || payload.detectedBranchPrefix,
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
      settings.branchPrefix || detected;
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
    const branches = await Promise.all(
      rawBranches.map(async (branch, index) => {
        const parent = index === 0 ? parsed.data.trunk : rawBranches[index - 1].name;
        const diffPromise = branchChangeSet(cwd, parent, branch.name);
        if (!branch.pr) {
          return { ...branch, pr: null, diff: await diffPromise };
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
        return {
          ...branch,
          pr: { ...branch.pr, title, isDraft },
          diff: await diffPromise,
        };
      }),
    );
    // The stack's own namespace wins over the checked-out branch's.
    const detected =
      branchPrefixOf(branches.map((branch) => branch.name)) ?? headPrefix;
    return {
      stack: { ...parsed.data, branches },
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
        return { ...cached.payload, fetchedAt: cached.fetchedAt };
      }
      const payload = await refreshStack(threadId);
      const entry = stackCache.get(threadId);
      if (entry) entry.lastReadAt = Date.now();
      return { ...payload, fetchedAt: entry?.fetchedAt ?? Date.now() };
    },

    async setPrDraft({ threadId, prNumber, draft }) {
      const workspace = await resolveWorkspace(threadId);
      if (workspace.error) {
        return { ok: false, message: workspace.error.message, detail: null };
      }
      const cwd = workspace.cwd;

      const args = draft
        ? ["pr", "ready", String(prNumber), "--undo"]
        : ["pr", "ready", String(prNumber)];
      bb.log.info(`running gh ${args.join(" ")} in ${cwd}`);
      const result = await runGh(args, cwd, 30_000);
      const detail = outputTail(result);
      if (result.failedToSpawn || result.timedOut || result.code !== 0) {
        const reason = result.stderr.trim().split("\n").pop() ?? "";
        return {
          ok: false,
          message:
            reason || `gh pr ready exited with code ${result.code}.`,
          detail,
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
      const cwd = workspace.cwd;

      const args =
        action === "sync"
          ? ["stack", "sync"]
          : ["stack", "submit", "--auto"];
      bb.log.info(`running gh ${args.join(" ")} in ${cwd}`);
      const result = await runGh(args, cwd, 180_000);
      const detail = outputTail(result);

      if (result.code !== 0) {
        return { ok: false, message: mapExitCode(result).message, detail };
      }
      // sync exits 0 but makes no changes when local and remote diverged.
      if (action === "sync" && /sync aborted/i.test(`${result.stdout}${result.stderr}`)) {
        return {
          ok: false,
          message:
            "Local and remote stacks diverged; sync aborted with no changes. See the command output for both chains.",
          detail,
        };
      }
      return {
        ok: true,
        message:
          action === "sync"
            ? "Stack synced: fetched, rebased, pushed, and PR state refreshed."
            : "Stack submitted: branches pushed and draft PRs opened.",
        detail,
      };
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
      // An existing stack must be extended, not re-initialized.
      const view = await runGh(["stack", "view", "--json"], workspace.cwd, 30_000);
      const hasStack = view.code === 0;
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
          branchPrefix:
            next.branchPrefix || entry.payload.detectedBranchPrefix,
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
