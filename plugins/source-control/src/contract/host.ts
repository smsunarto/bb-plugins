/**
 * The server ↔ host contract. Reads are retryable; the forge call carries a
 * closed union of operations, never an argv proxy.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { forgeValueSchema, localValueSchema } from "../core/change.ts";
import { repoSchema } from "../core/ids.ts";

const pathSchema = z.string().min(1).max(4096);

export const hostWorkspaceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("branch"), local: localValueSchema }).strict(),
  /** A checkout with no branch checked out (detached HEAD, or mid-rebase). */
  z.object({ state: z.literal("detached"), path: z.string() }).strict(),
  z.object({ state: z.literal("not-git"), path: z.string() }).strict(),
]);
export type HostWorkspace = z.infer<typeof hostWorkspaceSchema>;

/** A failure the server turns into a facet problem. */
export const hostFailureSchema = z
  .object({
    code: z.enum([
      "git-missing",
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

export const sourceControlHostContract = defineRpcContract({
  workspace: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema }).strict(),
    output: outcome(hostWorkspaceSchema),
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
