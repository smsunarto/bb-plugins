/**
 * The server ↔ host contract. Reads are retryable; writes (`vcsAction`) are
 * not. The forge call carries a closed union of operations, never an argv
 * proxy. The host says unasked when a watched checkout changed.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  forgeValueSchema,
  patchesSchema,
  patchSourceSchema,
  revisionSchema,
  vcsActionSchema,
  vcsResultSchema,
  workspaceValueSchema,
} from "../core/change.ts";
import { repoSchema } from "../core/ids.ts";

const pathSchema = z.string().min(1).max(4096);

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

export const forgeOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("pr.read"),
      repo: repoSchema,
      headOwner: z.string().min(1),
      branch: z.string().min(1),
    })
    .strict(),
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
    output: outcome(forgeValueSchema),
  },
});

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
