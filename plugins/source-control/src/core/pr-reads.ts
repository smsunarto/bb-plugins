/**
 * Pull requests read by reference (`owner/repo#N`) for other plugins: GenUI's
 * `PullRequest(refs)` lists pull requests an answer names, across
 * repositories, with their state, checks and review. The facts are GitHub's,
 * unlabelled: each reader decides what they mean for its own UI.
 */
import { z } from "zod";
import { prRefSchema } from "./watch.ts";

/** Most pull requests one read takes. */
export const MAX_PR_REFS = 20;

export const prStatusSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
    state: z.enum(["open", "merged", "closed"]),
    isDraft: z.boolean(),
    baseRef: z.string(),
    headRef: z.string(),
    /** GitHub's ISO time, or null when it gave none. */
    updatedAt: z.string().nullable(),
    /** GitHub's `mergeable`: whether the head merges without conflicts. */
    mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    /** GitHub's `mergeStateStatus`, verbatim; null when it gave none. */
    mergeStateStatus: z.string().nullable(),
    reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
    reviewRequests: z.number().int().nonnegative(),
    /** Check runs and commit statuses on the head commit, by outcome. */
    checks: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict(),
    autoMerge: z.boolean(),
    inMergeQueue: z.boolean(),
  })
  .strict();
export type PrStatus = z.infer<typeof prStatusSchema>;

export const prStatusesInputSchema = z
  .object({
    /** The calling thread's environment: its host's `gh` is tried after the bb server's. */
    environmentId: z.string().min(1).max(128).nullable(),
    refs: z.array(prRefSchema).min(1).max(MAX_PR_REFS),
  })
  .strict();

/** What one ref answered: the pull request, or why it can't be read. Keyed by `owner/repo#N`. */
export const prStatusReadSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: prStatusSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["not-found", "unavailable"]),
      message: z.string(),
    })
    .strict(),
]);
export type PrStatusRead = z.infer<typeof prStatusReadSchema>;
