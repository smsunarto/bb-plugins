/**
 * The canonical model of a Change, shared by every tier. A Change has
 * facets, each read from its own source. A facet's last good value and its
 * current problem are independent: "last value kept, host now offline" is a
 * legal state, and is what the offline card shows.
 */
import { z } from "zod";
import { changeKeySchema, repoSchema } from "./ids.ts";

/** Why a facet could not be read now. Each names where it happened. */
export const problemSchema = z.discriminatedUnion("kind", [
  /** The checkout's host is disconnected or did not answer in time. */
  z.object({ kind: z.literal("host-offline"), host: z.string() }).strict(),
  /** A tool the read needs is not installed where it ran. */
  z
    .object({
      kind: z.literal("tool-missing"),
      tool: z.enum(["git", "gh"]),
      host: z.string(),
      detail: z.string(),
    })
    .strict(),
  /** `gh` is installed but not signed in, or its token was refused. */
  z.object({ kind: z.literal("auth"), site: z.string(), detail: z.string() }).strict(),
  z.object({ kind: z.literal("rate-limited"), site: z.string(), detail: z.string() }).strict(),
  /** No connected site has a signed-in `gh` to read GitHub from. */
  z.object({ kind: z.literal("no-site"), host: z.string() }).strict(),
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

/** What a checkout's host says about the branch it has checked out. */
export const localValueSchema = z
  .object({
    path: z.string(),
    commonDir: z.string(),
    branch: z.string(),
    head: z.string().nullable(),
    /** The pull-request repository and branch owner, when the checkout is on GitHub. */
    github: z.object({ repo: repoSchema, headOwner: z.string() }).strict().nullable(),
    /** Ahead and behind its remote branch, or null before the first push. */
    upstream: z
      .object({ ref: z.string(), ahead: z.number().int(), behind: z.number().int() })
      .strict()
      .nullable(),
    uncommitted: z.array(fileChangeSchema).max(MAX_UNCOMMITTED),
    /** Files past `MAX_UNCOMMITTED`, counted but not listed. */
    moreUncommitted: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
    /** This branch's own commits, newest first, up to `MAX_COMMITS`. */
    commits: z.array(z.object({ id: z.string(), subject: z.string() }).strict()).max(MAX_COMMITS),
  })
  .strict();
export type LocalValue = z.infer<typeof localValueSchema>;

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
    checks: z
      .object({ passed: z.number().int(), failed: z.number().int(), pending: z.number().int() })
      .strict(),
  })
  .strict();
export type PullRequest = z.infer<typeof pullRequestSchema>;

/** The forge facet's value: the branch's pull request, or null when it has none. */
export const forgeValueSchema = pullRequestSchema.nullable();
export type ForgeValue = z.infer<typeof forgeValueSchema>;

export const placementSchema = z
  .object({ hostId: z.string(), hostName: z.string(), path: z.string(), environmentId: z.string() })
  .strict();
export type Placement = z.infer<typeof placementSchema>;

/**
 * One thread's Change, as the keyed `changeForThread` read returns it.
 * `key` is null until the checkout has been read once.
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
      key: changeKeySchema.nullable(),
      local: facetSchema(localValueSchema),
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
  | { kind: "ready"; local: LocalValue; readAt: number; stale: Problem | null };

export function tabView(row: ThreadChange | undefined): TabView {
  if (!row || row.state === "pending") return { kind: "loading" };
  if (row.state === "none") return { kind: "none", reason: row.reason };
  const { read, problem } = row.local;
  if (read) return { kind: "ready", local: read.value, readAt: read.at, stale: problem };
  return problem ? { kind: "failed", problem } : { kind: "loading" };
}

/** Whether a facet's value is behind the checkout: the pull request was read for another head. */
export function forgeIsBehind(local: LocalValue, forge: ForgeValue): boolean {
  return (
    forge !== null &&
    local.head !== null &&
    forge.state === "open" &&
    forge.headRefOid !== local.head
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
      return problem.tool === "git"
        ? `${problem.host} has no git, so bb cannot read this checkout.`
        : `${problem.host} has no GitHub CLI (gh).`;
    case "auth":
      return `GitHub CLI on ${problem.site} is not signed in. Run gh auth login there.`;
    case "rate-limited":
      return `GitHub is rate-limiting ${problem.site}. bb will read again later.`;
    case "no-site":
      return `No signed-in GitHub CLI on the bb server or ${problem.host}, so pull request state is unknown.`;
    case "failed":
      return `Reading from ${problem.site} failed.`;
  }
}
