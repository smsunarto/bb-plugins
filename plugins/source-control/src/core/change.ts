/**
 * The canonical model of a Change, shared by every tier. A Change has
 * facets, each read from its own source. A facet's last good value and its
 * current problem are independent: "last value kept, host now offline" is a
 * legal state, and is what the offline card shows.
 */
import { z } from "zod";
import { changeKeyOf, changeKeySchema, repoSchema, type ChangeKey } from "./ids.ts";

/** Why a facet could not be read now. Each names where it happened. */
export const problemSchema = z.discriminatedUnion("kind", [
  /** The checkout's host is disconnected or did not answer in time. */
  z.object({ kind: z.literal("host-offline"), host: z.string() }).strict(),
  /** A tool the read needs is not installed where it ran. */
  z
    .object({
      kind: z.literal("tool-missing"),
      tool: z.enum(["git", "gh", "but"]),
      host: z.string(),
      detail: z.string(),
    })
    .strict(),
  /** `gh` is installed but not signed in, or its token was refused. */
  z.object({ kind: z.literal("auth"), site: z.string(), detail: z.string() }).strict(),
  z.object({ kind: z.literal("rate-limited"), site: z.string(), detail: z.string() }).strict(),
  /** No connected site has a signed-in `gh` to read GitHub from. */
  z.object({ kind: z.literal("no-site"), host: z.string() }).strict(),
  /** The thread's checkout is no longer where the write was asked for. */
  z.object({ kind: z.literal("moved"), detail: z.string() }).strict(),
  z.object({ kind: z.literal("failed"), site: z.string(), detail: z.string() }).strict(),
]);
export type Problem = z.infer<typeof problemSchema>;

/** One facet: the last good read (null before the first) and the current problem. */
export function facetSchema<T extends z.ZodType>(value: T) {
  return z
    .object({
      read: z.object({ value, at: z.number().int().nonnegative() }).strict().nullable(),
      problem: problemSchema.nullable(),
    })
    .strict();
}
export type Facet<T> = { read: { value: T; at: number } | null; problem: Problem | null };

export const EMPTY_FACET: Facet<never> = Object.freeze({ read: null, problem: null });

export function succeeded<T>(value: T, at: number): Facet<T> {
  return { read: { value, at }, problem: null };
}

/** A failed read keeps the last good value. */
export function failed<T>(previous: Facet<T> | null, problem: Problem): Facet<T> {
  return { read: previous?.read ?? null, problem };
}

export const MAX_UNCOMMITTED = 500;
export const MAX_COMMITS = 50;

export const fileChangeSchema = z
  .object({ path: z.string(), kind: z.enum(["added", "modified", "deleted", "renamed", "copied"]) })
  .strict();
export type FileChange = z.infer<typeof fileChangeSchema>;

export const commitSchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    /** ISO time the commit was made, when the provider reports it. */
    createdAt: z.string().nullable(),
    conflicted: z.boolean(),
  })
  .strict();
export type Commit = z.infer<typeof commitSchema>;

/** A branch head's push state. Ported from GitButler's statuses; plain git derives the same. */
export const branchStatusSchema = z.enum([
  "unpushed",
  "pushed",
  "ahead",
  /** The remote has commits this branch lacks, and this branch has nothing the remote lacks. */
  "behind",
  "diverged",
  "integrated",
  "conflicted",
  "empty",
  "unknown",
]);
export type BranchStatus = z.infer<typeof branchStatusSchema>;

/** What a Push button would do: nothing to send, a plain push, or a force push. */
export const pushModeSchema = z.enum(["none", "push", "force"]);

export const branchSchema = z
  .object({
    name: z.string().min(1),
    /** The branch's newest commit, or null for a branch with none yet. */
    head: z.string().nullable(),
    /**
     * The remote branch it tracks: `ref` as `origin/x`, and `name` as the
     * remote names the branch. A pull request's head is `name`, which can
     * differ from the local name.
     */
    remote: z
      .object({ ref: z.string().min(1), name: z.string().min(1) })
      .strict()
      .nullable(),
    status: branchStatusSchema,
    push: pushModeSchema,
    /** Commits here and not on the remote, and there and not here. */
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    /**
     * Remote commits with no equivalent here: what Pull brings in, and what a
     * force push deletes. A rebased branch's old copies are not counted.
     */
    newUpstream: z.number().int().nonnegative(),
    /** The forge's own form ("#42"), when the provider knows a review for the branch. */
    reviewId: z.string().nullable(),
    /** This branch's own commits, newest first, up to `MAX_COMMITS`. */
    commits: z.array(commitSchema).max(MAX_COMMITS),
    moreCommits: z.number().int().nonnegative(),
    /** Remote commits not here, newest first, up to `MAX_COMMITS`. */
    upstreamCommits: z.array(commitSchema).max(MAX_COMMITS),
  })
  .strict();
export type Branch = z.infer<typeof branchSchema>;

export const stackSchema = z
  .object({
    /** Stable across reads: the bottom branch's name. */
    key: z.string().min(1),
    /** Top of the stack first. A plain checkout has one stack of one branch. */
    branches: z.array(branchSchema).min(1),
    /** Uncommitted files GitButler has assigned to this stack. */
    assigned: z.array(fileChangeSchema).max(MAX_UNCOMMITTED),
  })
  .strict();
export type Stack = z.infer<typeof stackSchema>;

/** The branch the workspace is based on, such as `origin/main`. */
export const targetSchema = z
  .object({
    ref: z.string().min(1),
    /** Its newest commit as the checkout last fetched it. */
    head: z.string().nullable(),
    /** Target commits the workspace does not have yet. */
    behind: z.number().int().nonnegative(),
    /** The commit the workspace is based on. */
    base: z.object({ id: z.string(), subject: z.string() }).strict().nullable(),
    /** When the target was last fetched, as an ISO time, when known. */
    lastFetched: z.string().nullable(),
  })
  .strict();
export type Target = z.infer<typeof targetSchema>;

/**
 * What a checkout's host says about it, the same shape from every workspace
 * provider. One checkout can serve several threads, so this carries no
 * thread: the server picks each thread's branch from `stacks`.
 */
export const workspaceValueSchema = z
  .object({
    provider: z.enum(["git", "gitbutler"]),
    path: z.string(),
    commonDir: z.string(),
    /** The checked-out branch of a plain checkout; null in a GitButler workspace. */
    checkedOut: z.string().nullable(),
    /** The pull-request repository and branch owner, when the checkout is on GitHub. */
    github: z.object({ repo: repoSchema, headOwner: z.string() }).strict().nullable(),
    /** Uncommitted files no stack holds: all of them in a plain checkout. */
    uncommitted: z.array(fileChangeSchema).max(MAX_UNCOMMITTED),
    /** Files past `MAX_UNCOMMITTED`, counted but not listed. */
    moreUncommitted: z.number().int().nonnegative(),
    /** Uncommitted files holding conflict markers. */
    conflicted: z.array(z.string()).max(MAX_UNCOMMITTED),
    stacks: z.array(stackSchema),
    target: targetSchema.nullable(),
  })
  .strict();
export type WorkspaceValue = z.infer<typeof workspaceValueSchema>;

/** Every branch of a workspace, with its stack. */
export function branchesOf(workspace: WorkspaceValue): { stack: Stack; branch: Branch }[] {
  return workspace.stacks.flatMap((stack) => stack.branches.map((branch) => ({ stack, branch })));
}

export function findBranch(workspace: WorkspaceValue, name: string | null): Branch | null {
  if (name === null) return null;
  return branchesOf(workspace).find((entry) => entry.branch.name === name)?.branch ?? null;
}

/** The name a branch has on its remote, which a pull request's head names. */
export function remoteBranchName(branch: Branch): string {
  return branch.remote?.name ?? branch.name;
}

/** The Change a branch of a checkout is: keyed by its remote name, so a renamed local branch is the same Change. */
export function changeKeyForBranch(
  hostId: string,
  workspace: WorkspaceValue,
  branch: Branch,
): ChangeKey {
  return changeKeyOf(
    { hostId, commonDir: workspace.commonDir, branch: remoteBranchName(branch) },
    workspace.github,
  );
}

/** Uncommitted files anywhere in the workspace, counted. */
export function uncommittedCount(workspace: WorkspaceValue): number {
  return (
    workspace.uncommitted.length +
    workspace.moreUncommitted +
    workspace.stacks.reduce((sum, stack) => sum + stack.assigned.length, 0)
  );
}

/** Uncommitted work, or one commit's changes. */
export const patchSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z
    .object({ kind: z.literal("commit"), commitId: z.string().regex(/^[0-9a-fA-F]{7,64}$/) })
    .strict(),
]);
export type PatchSource = z.infer<typeof patchSourceSchema>;

/** One file's change as a complete git patch Pierre can parse. Ported from GitButler. */
export const filePatchSchema = z
  .object({
    path: z.string(),
    kind: fileChangeSchema.shape.kind,
    /** The old path of a renamed file; null when the path did not change. */
    previousPath: z.string().nullable(),
    patch: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type FilePatch = z.infer<typeof filePatchSchema>;
export const patchesSchema = z.object({ files: z.array(filePatchSchema) }).strict();
export type Patches = z.infer<typeof patchesSchema>;

/**
 * The revision a write is made against. The host refuses with `conflict`
 * when the checkout has moved since, and changes nothing.
 */
export const revisionSchema = z
  .object({
    /** The named branch's head, or null for a write on the whole workspace. */
    head: z.string().nullable(),
    /** The target's head the reader saw. */
    target: z.string().nullable(),
  })
  .strict();
export type Revision = z.infer<typeof revisionSchema>;

/**
 * What a write would do beyond its own job, which the reader accepts first:
 * leave commits in these branches conflicted, or write conflict markers into
 * uncommitted files. Ported from GitButler.
 */
export const actionRiskSchema = z
  .object({ conflicted: z.array(z.string()), overlapsUncommitted: z.boolean() })
  .strict();
export type ActionRisk = z.infer<typeof actionRiskSchema>;

const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s-]\S*$/)
  .refine((name) => !name.startsWith("refs/"));

/** The panel's writes. Each names its branch; none is retried automatically. */
export const vcsActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("push"),
      branch: branchNameSchema,
      force: z.boolean(),
      /** Remote commit ids the reader agreed a force push deletes. */
      acceptedLoss: z.array(z.string()).max(1_000),
    })
    .strict(),
  /** Brings the workspace up to its target. */
  z.object({ kind: z.literal("pull"), accepted: actionRiskSchema.nullable() }).strict(),
  z
    .object({
      kind: z.literal("land"),
      branch: branchNameSchema,
      /** The message a branch of several commits is squashed into first; null for one commit. */
      message: z.string().max(20_000).regex(/\S/).nullable(),
      accepted: actionRiskSchema.nullable(),
    })
    .strict(),
]);
export type VcsAction = z.infer<typeof vcsActionSchema>;

/** How a write ended. Only `done` changed anything. */
export const vcsResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done") }).strict(),
  z.object({ status: z.literal("upToDate") }).strict(),
  /** Nothing ran: the reader is asked about `risk` (or `loss` for a force push) first. */
  z
    .object({
      status: z.literal("confirm"),
      risk: actionRiskSchema.nullable(),
      loss: z.array(z.string()).nullable(),
    })
    .strict(),
  /** Nothing ran: the checkout is no longer at the revision the write named. */
  z.object({ status: z.literal("conflict"), detail: z.string() }).strict(),
  z.object({ status: z.literal("failed"), problem: problemSchema }).strict(),
]);
export type VcsResult = z.infer<typeof vcsResultSchema>;

/** A pull request as GitHub reports it for the head the branch had then. */
export const pullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
    state: z.enum(["open", "closed", "merged"]),
    isDraft: z.boolean(),
    headRefOid: z.string(),
    baseRef: z.string(),
    reviewDecision: z.enum(["approved", "changes-requested", "review-required"]).nullable(),
    /** Reviewers whose latest opinion is an approval. */
    approvals: z.number().int().nonnegative(),
    /** Whether GitHub can merge the head into the base; `unknown` while it is still computing. */
    mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    commits: z.number().int().nonnegative(),
    checks: z
      .object({ passed: z.number().int(), failed: z.number().int(), pending: z.number().int() })
      .strict(),
  })
  .strict();
export type PullRequest = z.infer<typeof pullRequestSchema>;

/** One check run or commit status on the pull request's head. Skipped and neutral count as passed. */
export const checkRowSchema = z
  .object({
    name: z.string(),
    /** The Actions workflow the run belongs to, when it is one. */
    workflow: z.string().nullable(),
    outcome: z.enum(["passed", "failed", "pending", "skipped"]),
    url: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict();
export type CheckRow = z.infer<typeof checkRowSchema>;

/**
 * The checks facet's value: every check on the pull request's head, or null
 * without a pull request. `more` when GitHub had more than were read.
 */
export const checksValueSchema = z
  .object({ head: z.string(), rows: z.array(checkRowSchema).max(100), more: z.boolean() })
  .strict()
  .nullable();
export type ChecksValue = z.infer<typeof checksValueSchema>;

/** A write to the pull request, made only if its head is still `expected.head`. */
export const forgeActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setDraft"), draft: z.boolean() }).strict(),
]);
export type ForgeAction = z.infer<typeof forgeActionSchema>;

export const forgeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done") }).strict(),
  /** Already so: nothing ran. */
  z.object({ status: z.literal("upToDate") }).strict(),
  /** Nothing ran: the pull request's head moved since the reader looked. */
  z.object({ status: z.literal("conflict"), detail: z.string() }).strict(),
  z.object({ status: z.literal("failed"), problem: problemSchema }).strict(),
]);
export type ForgeResult = z.infer<typeof forgeResultSchema>;

/** The forge facet's value: the branch's pull request, or null when it has none. */
export const forgeValueSchema = pullRequestSchema.nullable();
export type ForgeValue = z.infer<typeof forgeValueSchema>;

/** A pull request read: the pull request and its checks, from one GitHub call. */
export const forgeReadSchema = z
  .object({ pullRequest: forgeValueSchema, checks: checksValueSchema })
  .strict();
export type ForgeRead = z.infer<typeof forgeReadSchema>;

export const placementSchema = z
  .object({ hostId: z.string(), hostName: z.string(), path: z.string(), environmentId: z.string() })
  .strict();
export type Placement = z.infer<typeof placementSchema>;

/**
 * One thread's Change, as the keyed `changeForThread` read returns it.
 * `local` is the checkout's facet, shared by every thread on the checkout;
 * `branch` is this thread's branch in it. `key` is null until the checkout
 * has been read once, and while the thread has no branch of its own.
 */
export const threadChangeSchema = z.discriminatedUnion("state", [
  /** Nothing read yet for this thread. */
  z.object({ state: z.literal("pending") }).strict(),
  /** The thread has no checkout a Change can come from; `reason` says why. */
  z.object({ state: z.literal("none"), reason: z.string() }).strict(),
  z
    .object({
      state: z.literal("checkout"),
      placement: placementSchema,
      /** Read as plain git although the checkout is a GitButler workspace, by the reader's choice. */
      readAsGit: z.boolean(),
      branch: z.string().nullable(),
      key: changeKeySchema.nullable(),
      local: facetSchema(workspaceValueSchema),
      forge: facetSchema(forgeValueSchema),
    })
    .strict(),
]);
export type ThreadChange = z.infer<typeof threadChangeSchema>;
export type CheckoutChange = Extract<ThreadChange, { state: "checkout" }>;

/**
 * What the Changes tab shows, as one value: every surface draws from this,
 * never from "is there data".
 */
export type TabView =
  | { kind: "loading" }
  | { kind: "none"; reason: string }
  | { kind: "failed"; problem: Problem }
  | {
      kind: "ready";
      workspace: WorkspaceValue;
      /** This thread's branch, when it has one in the workspace. */
      branch: Branch | null;
      readAt: number;
      stale: Problem | null;
    };

export function tabView(row: ThreadChange | undefined): TabView {
  if (!row || row.state === "pending") return { kind: "loading" };
  if (row.state === "none") return { kind: "none", reason: row.reason };
  const { read, problem } = row.local;
  if (read)
    return {
      kind: "ready",
      workspace: read.value,
      branch: findBranch(read.value, row.branch),
      readAt: read.at,
      stale: problem,
    };
  return problem ? { kind: "failed", problem } : { kind: "loading" };
}

/** Whether the pull request was read for another head than the branch has now. */
export function forgeIsBehind(branch: Branch, forge: ForgeValue): boolean {
  return (
    forge !== null &&
    branch.head !== null &&
    forge.state === "open" &&
    forge.headRefOid !== branch.head
  );
}
/** "Read 12 min ago": age labels for last-read times. */
export function readAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "Read just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Read ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Read ${hours} h ago`;
  return `Read ${Math.round(hours / 24)} days ago`;
}

/** One line a person can act on, for each problem. */
export function describeProblem(problem: Problem): string {
  switch (problem.kind) {
    case "host-offline":
      return `${problem.host} is not answering.`;
    case "tool-missing":
      if (problem.tool === "git")
        return `${problem.host} has no git, so bb cannot read this checkout.`;
      if (problem.tool === "but")
        return `This checkout is a GitButler workspace, and ${problem.host} has no GitButler CLI (but).`;
      return `${problem.host} has no GitHub CLI (gh).`;
    case "auth":
      return `GitHub CLI on ${problem.site} is not signed in. Run gh auth login there.`;
    case "rate-limited":
      return `GitHub is rate-limiting ${problem.site}. bb will read again later.`;
    case "no-site":
      return `No signed-in GitHub CLI on the bb server or ${problem.host}, so pull request state is unknown.`;
    case "moved":
      return `The thread's checkout moved. ${problem.detail}`;
    case "failed":
      return `Reading from ${problem.site} failed.`;
  }
}
