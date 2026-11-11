import { z } from "zod";
import type { GitButlerContext } from "../lib/context.ts";

/** The KV prefixes this plugin writes, and what each holds. */
const PREFIXES = {
  /** Which branch each thread works on, derived from the `but` commands in its history. */
  threadBranches: "thread-branch-v3:",
  /** "Create PR" subthreads per checkout. */
  reviewRequests: "review-requests:",
  /** Conflict-resolution threads per checkout. */
  conflictResolutions: "conflict-resolution:",
} as const;

/**
 * Everything this plugin keeps in its own storage, as stored, for Source
 * Control's import at the cutover. Read-only: it changes nothing, so a
 * rollback finds the plugin's data where it was. Thread metadata
 * (`panelTabOffered`) and panel tab records live in bb, not here.
 */
export const exportForCutoverContract = {
  input: z.strictObject({}),
  output: z.strictObject({
    version: z.literal(1),
    records: z.array(
      z.strictObject({
        kind: z.enum(["threadBranches", "reviewRequests", "conflictResolutions", "other"]),
        key: z.string(),
        value: z.unknown(),
      }),
    ),
  }),
};

export async function exportForCutover({ bb }: GitButlerContext) {
  const kv = bb.storage.kv;
  const keys = await kv.list("");
  const kindOf = (key: string) =>
    (Object.entries(PREFIXES).find(([, prefix]) => key.startsWith(prefix))?.[0] ?? "other") as
      | keyof typeof PREFIXES
      | "other";
  return {
    version: 1 as const,
    records: await Promise.all(
      keys.map(async (key) => ({ kind: kindOf(key), key, value: await kv.get<unknown>(key) })),
    ),
  };
}
