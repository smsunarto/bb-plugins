import { createHash } from "node:crypto";
import { z } from "zod";
import {
  GITBUTLER_VERSION,
  branchNameSchema,
  repositoryRelativePathSchema,
  type ChangedFile,
  type HostRepositorySnapshot,
  type HunkRevisionKey,
} from "../shared/domain.ts";

const rawChangeSchema = z
  .object({
    cliId: z.string().min(1),
    filePath: repositoryRelativePathSchema,
    changeType: z.string().min(1),
  })
  .strict();

const rawBaseCommitSchema = z
  .object({
    cliId: z.string(),
    commitId: z.string().min(1),
    createdAt: z.string(),
    message: z.string(),
    authorName: z.string(),
    authorEmail: z.string(),
    conflicted: z.null(),
    reviewId: z.string().nullable(),
    changes: z.null(),
  })
  .strict();

const rawCommitSchema: z.ZodType<RawCommit023> = z
  .object({
    cliId: z.string().min(1),
    changeId: z.string().min(1),
    commitId: z.string().min(1),
    createdAt: z.string(),
    message: z.string(),
    authorName: z.string(),
    authorEmail: z.string(),
    conflicted: z.boolean(),
    reviewId: z.string().nullable(),
    changes: z.array(rawChangeSchema),
  })
  .strict();

const rawCiSchema = z
  .object({
    pendingCheckTitles: z.array(z.string()),
    passingCheckTitles: z.array(z.string()),
    failingCheckTitles: z.array(z.string()),
    status: z.string(),
    conclusion: z.string(),
  })
  .strict();

const rawBranchSchema: z.ZodType<RawBranch023> = z
  .object({
    cliId: z.string().min(1),
    name: branchNameSchema,
    commits: z.array(rawCommitSchema),
    upstreamCommits: z.array(rawCommitSchema),
    branchStatus: z.string(),
    reviewId: z.string().nullable(),
    ci: rawCiSchema.nullable(),
  })
  .strict();

export const rawStatusSchema = z
  .object({
    uncommittedChanges: z.array(rawChangeSchema),
    stacks: z.array(
      z
        .object({
          cliId: z.string().min(1),
          assignedChanges: z.array(rawChangeSchema),
          branches: z.array(rawBranchSchema),
        })
        .strict(),
    ),
    mergeBase: rawBaseCommitSchema.nullable(),
    upstreamState: z
      .object({
        behind: z.number().int().nonnegative(),
        latestCommit: rawBaseCommitSchema.nullable(),
        lastFetched: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

const rawHunkSchema = z
  .object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    diff: z.string().min(1),
  })
  .strict();

const rawPatchDiffSchema = z
  .object({ type: z.literal("patch"), hunks: z.array(rawHunkSchema) })
  .strict();

const rawDiffChangeSchema = z
  .object({
    id: z.string().min(1),
    path: repositoryRelativePathSchema,
    status: z.string().min(1),
    diff: z.unknown(),
  })
  .strict();

export const rawDiffEnvelopeSchema = z.object({ changes: z.array(rawDiffChangeSchema) }).strict();

const branchListAuthorSchema = z.object({ name: z.string(), email: z.string() }).strict();
const branchListHeadSchema = z
  .object({
    name: branchNameSchema,
    reviews: z.array(z.unknown()),
    lastCommitAt: z.number().nullable(),
    commitsAhead: z.number().nullable(),
    lastAuthor: branchListAuthorSchema.nullable(),
  })
  .strict();
const branchListBranchSchema = branchListHeadSchema.extend({ hasLocal: z.boolean() }).strict();
const rawBranchListSchema = z
  .object({
    appliedStacks: z.array(
      z.object({ id: z.string().min(1), heads: z.array(branchListHeadSchema) }).strict(),
    ),
    branches: z.array(branchListBranchSchema),
    hasMoreBranches: z.boolean(),
  })
  .strict();

export type RawStatus023 = z.infer<typeof rawStatusSchema>;
export type RawDiffEnvelope023 = z.infer<typeof rawDiffEnvelopeSchema>;
type RawChange023 = z.infer<typeof rawChangeSchema>;
type RawCi023 = z.infer<typeof rawCiSchema>;

interface RawCommit023 {
  cliId: string;
  changeId: string;
  commitId: string;
  createdAt: string;
  message: string;
  authorName: string;
  authorEmail: string;
  conflicted: boolean;
  reviewId: string | null;
  changes: RawChange023[];
}

interface RawBranch023 {
  cliId: string;
  name: string;
  commits: RawCommit023[];
  upstreamCommits: RawCommit023[];
  branchStatus: string;
  reviewId: string | null;
  ci: RawCi023 | null;
}

declare const cliSelectorBrand: unique symbol;
export type GitButlerCliSelector = string & { readonly [cliSelectorBrand]: true };

export interface ParsedRepository {
  readonly view: HostRepositorySnapshot;
  readonly selectors: {
    readonly hunksByRevision: ReadonlyMap<HunkRevisionKey, readonly GitButlerCliSelector[]>;
  };
}

export class GitButlerOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitButlerOutputError";
  }
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (cause) {
    throw new GitButlerOutputError(`${label} was not valid JSON`, { cause });
  }
}

export function parseStatus023(stdout: string): RawStatus023 {
  const parsed = rawStatusSchema.safeParse(parseJson(stdout, "GitButler status"));
  if (!parsed.success) {
    throw new GitButlerOutputError(
      `GitButler status did not match 0.22.3: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function parseWorktreeDiff023(stdout: string): RawDiffEnvelope023 {
  const parsed = rawDiffEnvelopeSchema.safeParse(parseJson(stdout, "GitButler diff"));
  if (!parsed.success) {
    throw new GitButlerOutputError(`GitButler diff did not match 0.22.3: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function parseBranchNames023(stdout: string): ReadonlySet<string> {
  const parsed = rawBranchListSchema.safeParse(parseJson(stdout, "GitButler branch list"));
  if (!parsed.success) {
    throw new GitButlerOutputError(
      `GitButler branch list did not match 0.22.3: ${parsed.error.message}`,
    );
  }
  return new Set([
    ...parsed.data.appliedStacks.flatMap((stack) => stack.heads.map((head) => head.name)),
    ...parsed.data.branches.map((branch) => branch.name),
  ]);
}

function toChangeKind(value: string): ChangedFile["kind"] {
  switch (value.toLowerCase()) {
    case "added":
      return "added";
    case "modified":
      return "modified";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "unknown";
  }
}

function toChangedFile(change: RawChange023): ChangedFile {
  return { path: change.filePath, kind: toChangeKind(change.changeType) };
}

function humanizeStatus(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[-_]+/gu, " ")
    .replace(/^./u, (first) => first.toUpperCase());
}

function mapCommit(commit: RawCommit023) {
  return {
    commitId: commit.commitId,
    changeId: commit.changeId,
    createdAt: commit.createdAt,
    message: commit.message,
    author: { name: commit.authorName, email: commit.authorEmail },
    conflicted: commit.conflicted,
    reviewId: commit.reviewId,
    files: commit.changes.map(toChangedFile),
  };
}

function snapshotRowKey(prefix: string, index: number, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `${prefix}:${index}:${digest}`;
}

export function makeHunkRevisionKey(path: string, exactPatch: string): HunkRevisionKey {
  const digest = createHash("sha256")
    .update("h1\0", "utf8")
    .update(path, "utf8")
    .update("\0", "utf8")
    .update(exactPatch, "utf8")
    .digest("hex");
  return `h1:${digest}`;
}

export function statusProjection(status: RawStatus023): string {
  return JSON.stringify(status);
}

export function buildParsedRepository(
  status: RawStatus023,
  diffs: RawDiffEnvelope023,
  capturedAt = Date.now(),
): ParsedRepository {
  const selectors = new Map<HunkRevisionKey, GitButlerCliSelector[]>();
  const worktreeByPath = new Map<
    string,
    {
      kind: ChangedFile["kind"];
      hunks: Array<{
        revisionKey: HunkRevisionKey;
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        patch: string;
      }>;
      unselectable: "binary" | "unsupported-diff" | "missing-diff" | null;
    }
  >();

  for (const change of status.uncommittedChanges) {
    worktreeByPath.set(change.filePath, {
      kind: toChangeKind(change.changeType),
      hunks: [],
      unselectable: "missing-diff",
    });
  }

  for (const change of diffs.changes) {
    const current = worktreeByPath.get(change.path) ?? {
      kind: toChangeKind(change.status),
      hunks: [],
      unselectable: "missing-diff" as const,
    };
    const patch = rawPatchDiffSchema.safeParse(change.diff);
    if (!patch.success) {
      current.unselectable =
        typeof change.diff === "object" &&
        change.diff !== null &&
        "type" in change.diff &&
        change.diff.type === "binary"
          ? "binary"
          : "unsupported-diff";
      worktreeByPath.set(change.path, current);
      continue;
    }
    if (patch.data.hunks.length !== 1) {
      current.unselectable = "unsupported-diff";
      worktreeByPath.set(change.path, current);
      continue;
    }
    const hunk = patch.data.hunks[0];
    if (hunk === undefined) continue;
    const revisionKey = makeHunkRevisionKey(change.path, hunk.diff);
    current.hunks.push({
      revisionKey,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      patch: hunk.diff,
    });
    current.unselectable = null;
    const matches = selectors.get(revisionKey) ?? [];
    matches.push(change.id as GitButlerCliSelector);
    selectors.set(revisionKey, matches);
    worktreeByPath.set(change.path, current);
  }

  const files = [...worktreeByPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, file]) => ({
      path,
      kind: file.kind,
      content:
        file.hunks.length > 0
          ? { kind: "text" as const, hunks: file.hunks }
          : { kind: "unselectable" as const, reason: file.unselectable ?? "missing-diff" },
    }));

  const stacks = status.stacks.map((stack, stackIndex) => ({
    rowKey: snapshotRowKey(
      "stack",
      stackIndex,
      stack.branches.map((branch) => branch.name).join("\0"),
    ),
    assignedFiles: stack.assignedChanges.map(toChangedFile),
    branches: stack.branches.map((branch, branchIndex) => ({
      rowKey: snapshotRowKey("branch", branchIndex, branch.name),
      branchName: branch.name,
      status: { code: branch.branchStatus, label: humanizeStatus(branch.branchStatus) },
      reviewId: branch.reviewId,
      ci:
        branch.ci === null
          ? null
          : {
              status: branch.ci.status,
              conclusion: branch.ci.conclusion,
              pendingChecks: branch.ci.pendingCheckTitles,
              passingChecks: branch.ci.passingCheckTitles,
              failingChecks: branch.ci.failingCheckTitles,
            },
      commits: branch.commits.map(mapCommit),
      upstreamCommits: branch.upstreamCommits.map(mapCommit),
    })),
  }));

  return {
    view: {
      gitButlerVersion: GITBUTLER_VERSION,
      capturedAt,
      mergeBase:
        status.mergeBase === null
          ? null
          : { commitId: status.mergeBase.commitId, message: status.mergeBase.message },
      upstream: {
        behind: status.upstreamState.behind,
        lastFetched: status.upstreamState.lastFetched,
      },
      stacks,
      worktree: {
        files,
        hunkCount: files.reduce(
          (total, file) => total + (file.content.kind === "text" ? file.content.hunks.length : 0),
          0,
        ),
      },
    },
    selectors: { hunksByRevision: selectors },
  };
}

export function branchCommitIds(
  status: RawStatus023,
  branchName: string,
): { matches: number; commitIds: ReadonlySet<string> } {
  const branches = status.stacks.flatMap((stack) =>
    stack.branches.filter((branch) => branch.name === branchName),
  );
  return {
    matches: branches.length,
    commitIds: new Set(
      branches.flatMap((branch) => branch.commits.map((commit) => commit.commitId)),
    ),
  };
}

export function repositoryObservation(parsed: ParsedRepository): string {
  return JSON.stringify({
    stacks: parsed.view.stacks,
    worktree: parsed.view.worktree,
    mergeBase: parsed.view.mergeBase,
    upstream: parsed.view.upstream,
  });
}

export function hunkExists(parsed: ParsedRepository, key: HunkRevisionKey): boolean {
  return (parsed.selectors.hunksByRevision.get(key)?.length ?? 0) > 0;
}

export function hunkSelector(
  parsed: ParsedRepository,
  key: HunkRevisionKey,
): GitButlerCliSelector | null {
  const matches = parsed.selectors.hunksByRevision.get(key);
  return matches?.length === 1 ? (matches[0] ?? null) : null;
}
