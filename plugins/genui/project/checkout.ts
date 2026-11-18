// A thread environment's checkout and pull request, both read through Source
// Control: the checkout through its plain-git reads (`checkoutStatus`,
// `checkoutFiles`, `checkoutPatches`), so bb's bundled Git plugin can stay
// disabled, and the pull request through `changeForThread`, as Source
// Control last read it for a thread on that checkout. The schemas copy only
// the fields this plugin reads; zod drops the rest.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

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

/** A pull request as Source Control's forge read stores it. */
const pullRequestSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
  baseRef: z.string(),
  reviewDecision: z.enum(["approved", "changes-requested", "review-required"]).nullable(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  checks: z.object({ passed: z.number(), failed: z.number(), pending: z.number() }),
});

/** A pull request as Source Control reports it. */
export type ForgePullRequest = z.infer<typeof pullRequestSchema>;

const threadChangeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("none"), reason: z.string() }),
  z.object({
    state: z.literal("checkout"),
    branch: z.string().nullable(),
    forge: z.object({
      read: z.object({ value: pullRequestSchema.nullable(), at: z.number() }).nullable(),
      problem: problemSchema.nullable(),
    }),
  }),
]);

/** One thread's Change as Source Control last read it. */
export type ThreadChange = z.infer<typeof threadChangeSchema>;

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

/** Most threads asked about per environment; Source Control takes 200. */
export const MAX_CHANGE_THREADS = 5;

/**
 * Each thread's Change as Source Control last read it, keyed by thread id.
 * Source Control serves these from its store, so asking never reads a host
 * or GitHub; a thread it hasn't read yet is `pending`.
 */
export function threadChanges(sdk: Sdk, threadIds: readonly string[]) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "changeForThread",
    input: { keys: [...threadIds] },
    outputSchema: z.record(z.string(), threadChangeSchema),
  });
}
