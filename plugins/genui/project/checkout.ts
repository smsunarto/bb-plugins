// A thread environment's checkout and pull request, both read through Source
// Control: the checkout through its plain-git reads (`checkoutStatus`,
// `checkoutFiles`, `checkoutPatches`), so bb's bundled Git plugin can stay
// disabled, and the pull request through `statusForThread`, as Source
// Control last read it for the threads on that checkout. The schemas copy
// only the fields this plugin reads; zod drops the rest.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_STATUS_KEYS, parseThreadStatuses, type ThreadStatus } from "../core/sourceControl";

type Sdk = BbPluginApi["sdk"];

const SOURCE_CONTROL = "source-control";

const problemSchema = z.object({
  kind: z.string(),
  host: z.string().optional(),
  detail: z.string().optional(),
});

/** Why Source Control couldn't read the checkout. */
export type CheckoutProblem = z.infer<typeof problemSchema>;

function read<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), problem: problemSchema }),
  ]);
}

const headSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("detached"), sha: z.string() }),
  z.object({ kind: z.literal("unborn"), name: z.string().nullable() }),
]);

/** What is checked out. */
export type CheckoutHead = z.infer<typeof headSchema>;

const statusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("not-git") }),
  z.object({
    state: z.literal("read"),
    head: headSchema,
    defaultBranch: z.string().nullable(),
    base: z.string().nullable(),
    uncommitted: z.object({ files: z.number(), additions: z.number(), deletions: z.number() }),
    mergeBase: z
      .object({
        ahead: z.number(),
        behind: z.number(),
        // Newest first.
        commits: z.array(
          z.object({
            sha: z.string(),
            subject: z.string(),
            author: z.string(),
            authoredAt: z.number(),
          }),
        ),
      })
      .nullable(),
  }),
]);

/** A checkout Source Control could read. */
export type CheckoutRead = Extract<z.infer<typeof statusSchema>, { state: "read" }>;

/** What a diff compares, as Source Control names it. */
export type CheckoutTarget =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "branch"; readonly base: string }
  | { readonly kind: "commit"; readonly sha: string };

const patchSchema = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });

const fileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  kind: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  untracked: z.boolean(),
});

/** One changed file, as `checkoutFiles` lists it. */
export type CheckoutFile = z.infer<typeof fileSchema>;

const filesSchema = read(
  z.object({ files: z.array(fileSchema), truncated: z.boolean(), patches: z.array(patchSchema) }),
);
const patchesSchema = read(z.object({ patches: z.array(patchSchema) }));

/** The checkout measured against `base`; null measures against its default branch. */
export function checkoutStatus(sdk: Sdk, environmentId: string, base: string | null) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "checkoutStatus",
    input: { environmentId, base },
    outputSchema: read(statusSchema),
  });
}

export function checkoutFiles(sdk: Sdk, environmentId: string, target: CheckoutTarget) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "checkoutFiles",
    input: { environmentId, target },
    outputSchema: filesSchema,
  });
}

/** Most files one `checkoutPatches` call takes. */
export const PATCH_BATCH = 25;

export function checkoutPatches(
  sdk: Sdk,
  environmentId: string,
  target: CheckoutTarget,
  files: readonly Pick<CheckoutFile, "path" | "previousPath">[],
) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "checkoutPatches",
    input: {
      environmentId,
      target,
      files: files.map(({ path, previousPath }) => ({ path, previousPath })),
    },
    outputSchema: patchesSchema,
  });
}

/**
 * Each thread's row as Source Control's `statusForThread` gives it, keyed by
 * thread id: its pull request, status line and tone, from Source Control's
 * store, so asking never reads a host or GitHub. Rows that don't parse are
 * left out.
 */
export async function threadStatuses(
  sdk: Sdk,
  threadIds: readonly string[],
): Promise<Record<string, ThreadStatus>> {
  if (threadIds.length === 0) return {};
  const rows = await sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "statusForThread",
    input: { keys: [...new Set(threadIds)].slice(0, MAX_STATUS_KEYS) },
    outputSchema: z.record(z.string(), z.unknown()),
  });
  return parseThreadStatuses(rows);
}
