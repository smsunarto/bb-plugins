/**
 * The server ↔ host contract. Reads are retryable; writes (`vcsAction`) are
 * not. The forge call carries a closed union of operations, never an argv
 * proxy. The host says unasked when a watched checkout changed.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  commitSchema,
  forgeReadSchema,
  forgeResultSchema,
  patchesSchema,
  patchSourceSchema,
  revisionSchema,
  vcsActionSchema,
  vcsResultSchema,
  workspaceValueSchema,
} from "../core/change.ts";
import { repoSchema } from "../core/ids.ts";
import { changeFileSchema } from "../core/review.ts";

const pathSchema = z.string().min(1).max(4096);
/** A commit id (four characters or more), or its first parent as `<id>^` for one commit's own diff. */
const commitIdSchema = z.string().regex(/^[0-9a-fA-F]{4,64}\^?$/);

/** How to read a checkout: by what it is, or as plain git whatever it is. */
export const readAsSchema = z.enum(["auto", "git"]);
export type ReadAs = z.infer<typeof readAsSchema>;

export const hostWorkspaceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("workspace"), value: workspaceValueSchema }).strict(),
  /** A plain checkout with no branch checked out (detached HEAD, or mid-rebase). */
  z.object({ state: z.literal("detached"), path: z.string() }).strict(),
  z.object({ state: z.literal("not-git"), path: z.string() }).strict(),
]);
export type HostWorkspace = z.infer<typeof hostWorkspaceSchema>;

/** A failure the server turns into a facet problem. */
export const hostFailureSchema = z
  .object({
    code: z.enum([
      "git-missing",
      /** The checkout is a GitButler workspace and `but` is not on this host. */
      "but-missing",
      "gh-missing",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "forbidden",
      "failed",
    ]),
    message: z.string(),
  })
  .strict();
export type HostFailure = z.infer<typeof hostFailureSchema>;

function outcome<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: hostFailureSchema }).strict(),
  ]);
}

/**
 * Which signed-in `gh` account runs a forge call: `active` is the one `gh`
 * uses by default; another runs with its own token. Null: the active one.
 */
export const forgeAccountSchema = z
  .object({ login: z.string().min(1), active: z.boolean() })
  .strict()
  .nullable();
export type ForgeAccount = z.infer<typeof forgeAccountSchema>;

const pullRequestQuery = {
  repo: repoSchema,
  headOwner: z.string().min(1),
  branch: z.string().min(1),
  account: forgeAccountSchema,
};

export const forgeOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pr.read"), ...pullRequestQuery }).strict(),
]);
export type ForgeOperation = z.infer<typeof forgeOperationSchema>;

/** How long a write may run on the host. */
export const ACTION_DEADLINE_MS = 5 * 60_000;

export const sourceControlHostContract = defineRpcContract({
  /**
   * The checkout's workspace. Reading it keeps the checkout watched for
   * `WATCH_LEASE_MS`, so the host signals the next change instead of being polled.
   */
  workspace: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema, readAs: readAsSchema }).strict(),
    output: outcome(hostWorkspaceSchema),
  },
  /** File patches of uncommitted work or one commit. */
  patches: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema, readAs: readAsSchema, source: patchSourceSchema }).strict(),
    output: outcome(patchesSchema),
  },
  /**
   * The checkout's files, patches or commits between two commits: what
   * `head` adds since it left `base`. Immutable for a pair of commits.
   */
  range: {
    experimental_retryable: true,
    input: z
      .object({
        path: pathSchema,
        base: commitIdSchema,
        head: commitIdSchema,
        read: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("files") }).strict(),
          z
            .object({ kind: z.literal("patches"), paths: z.array(z.string()).min(1).max(80) })
            .strict(),
          z.object({ kind: z.literal("commits") }).strict(),
        ]),
      })
      .strict(),
    output: outcome(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("files"), files: z.array(changeFileSchema) }).strict(),
        z.object({ kind: z.literal("patches"), files: patchesSchema.shape.files }).strict(),
        z.object({ kind: z.literal("commits"), commits: z.array(commitSchema) }).strict(),
      ]),
    ),
  },
  /** Keeps a checkout watched for another lease without reading it. */
  renewWatch: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema }).strict(),
    output: z.object({ watching: z.boolean() }).strict(),
  },
  /**
   * One write on the checkout, made only if it is still at `expected`.
   * Never retried: a transport failure leaves the outcome unknown.
   */
  vcsAction: {
    input: z
      .object({
        path: pathSchema,
        readAs: readAsSchema,
        action: vcsActionSchema,
        expected: revisionSchema,
      })
      .strict(),
    output: vcsResultSchema,
  },
  forgeAccounts: {
    experimental_retryable: true,
    input: z.object({}).strict(),
    output: outcome(z.object({ accounts: z.array(z.string()) }).strict()),
  },
  forgeCall: {
    experimental_retryable: true,
    input: forgeOperationSchema,
    output: outcome(forgeReadSchema),
  },
  /**
   * Marks the pull request draft or ready while its head is still
   * `expectedHead`. Convergent, so it may be retried.
   */
  forgeWrite: {
    experimental_retryable: true,
    input: z
      .object({
        op: z.literal("pr.setDraft"),
        ...pullRequestQuery,
        number: z.number().int().positive(),
        draft: z.boolean(),
        expectedHead: z.string().min(1),
      })
      .strict(),
    output: outcome(forgeResultSchema),
  },
});

export type RangeRead = z.infer<typeof sourceControlHostContract.range.input>["read"];
export type RangeAnswer = Extract<
  z.infer<typeof sourceControlHostContract.range.output>,
  { ok: true }
>["value"];

/** How long one read or renewal keeps a checkout watched. */
export const WATCH_LEASE_MS = 150_000;

/**
 * What the host says unasked: a watched checkout changed on disk (a file in
 * its working tree, its index or HEAD, a ref, or GitButler's own state), by
 * anything but this plugin's own reads.
 */
export const sourceControlHostSignals = {
  checkoutChanged: {
    /** Each checkout as the server named it in `workspace` or `renewWatch`. */
    payload: z.object({ paths: z.array(pathSchema).min(1).max(1_000) }).strict(),
  },
} as const;
