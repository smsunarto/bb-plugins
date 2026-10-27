import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  type ChangedFile,
  type ChangedFiles,
  type FileStatus,
  type LocalBranch,
  type LocalBranches,
  comparisonSchema,
} from "../../shared/schema.ts";
import type { Store } from "./store.ts";
import { isGenerated, parseGitattributes } from "./generated.ts";

/*
 * Unpublished branches come from the GitButler plugin, which reads every
 * GitButler workspace on every connected machine. Its `unpublishedBranches`
 * and `branchPatches` RPCs are the contract; the schemas below mirror only
 * the fields read here, and accept fields added later.
 */

export const GITBUTLER_PLUGIN_ID = "gitbutler";

const NOT_INSTALLED =
  "Install and enable the GitButler plugin to review branches that have no pull request yet.";

const commit = z.object({
  commitId: z.string(),
  message: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});

const unpublished = z.object({
  branches: z.array(
    z.object({
      hostId: z.string(),
      machine: z.string(),
      path: z.string(),
      repoName: z.string(),
      origin: z.string().nullable(),
      branch: z.string(),
      status: z.string(),
      head: z.string(),
      base: z.string(),
      parent: z.string().nullable(),
      commits: z.array(commit),
    }),
  ),
});

const patches = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      previousPath: z.string().nullable(),
      patch: z.string(),
      truncated: z.boolean(),
    }),
  ),
});

/** A branch's id: the same branch in the same checkout keeps it as it gains commits. */
export function branchId(hostId: string, path: string, branch: string): string {
  return createHash("sha256").update(`${hostId}\0${path}\0${branch}`).digest("hex").slice(0, 12);
}

/** `owner/repo` of a `github.com/owner/repo` origin. Null for any other host. */
function gitHubRepository(origin: string | null): string | null {
  const match = origin === null ? null : /^github\.com\/([^/]+\/[^/]+)$/i.exec(origin);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Whether the GitButler plugin is installed and on, asked only once a call to it failed. */
async function gitButlerEnabled(bb: BbPluginApi): Promise<boolean> {
  const { plugins } = await bb.sdk.plugins.list();
  return plugins.some((plugin) => plugin.id === GITBUTLER_PLUGIN_ID && plugin.enabled);
}

/** Every unpublished branch on every connected machine, newest commit first. */
export async function loadLocalBranches(
  bb: BbPluginApi,
  signal?: AbortSignal,
  scope?: { hostId: string; path?: string },
): Promise<LocalBranches> {
  let read: z.infer<typeof unpublished>;
  try {
    read = await bb.sdk.plugins.callRpc({
      pluginId: GITBUTLER_PLUGIN_ID,
      method: scope ? "unpublishedBranchesAt" : "unpublishedBranches",
      input: scope ?? null,
      outputSchema: unpublished,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (!(await gitButlerEnabled(bb).catch(() => true))) {
      return { available: false, reason: NOT_INSTALLED };
    }
    throw error;
  }
  const branches = read.branches
    .filter((branch) => branch.commits.length > 0)
    .map((branch): LocalBranch => ({
      id: branchId(branch.hostId, branch.path, branch.branch),
      hostId: branch.hostId,
      machine: branch.machine,
      path: branch.path,
      repoName: branch.repoName,
      repository: gitHubRepository(branch.origin),
      branch: branch.branch,
      status: branch.status,
      head: branch.head,
      base: branch.base,
      parent: branch.parent,
      commits: branch.commits.map(({ commitId, message, authorName, createdAt }) => ({
        commitId,
        message,
        authorName,
        createdAt,
      })),
    }))
    .toSorted((a, b) => newest(b) - newest(a));
  return { available: true, branches };
}

function newest(branch: LocalBranch): number {
  const time = Date.parse(branch.commits[0]?.createdAt ?? "");
  return Number.isNaN(time) ? 0 : time;
}

/** One unpublished branch by id, read fresh. Throws when it is gone or was published. */
export async function requireLocalBranch(bb: BbPluginApi, id: string): Promise<LocalBranch> {
  const read = await loadLocalBranches(bb);
  if (!read.available) throw new Error(read.reason);
  const branch = read.branches.find((each) => each.id === id);
  if (!branch) {
    throw new Error("That branch has no unpublished commits any more, or its machine is offline.");
  }
  return branch;
}

const STATUS: Readonly<Record<string, FileStatus>> = {
  added: "added",
  modified: "modified",
  deleted: "removed",
  renamed: "renamed",
  copied: "copied",
};

/** Everything `head` changes since `base`, in the shape the Changes tab reads. */
export async function loadLocalChanges(
  bb: BbPluginApi,
  range: { hostId: string; path: string; base: string; head: string },
): Promise<ChangedFiles> {
  const read = await bb.sdk.plugins.callRpc({
    pluginId: GITBUTLER_PLUGIN_ID,
    method: "branchPatches",
    input: range,
    outputSchema: patches,
  });
  const rules = parseGitattributes("");
  const comparison = comparisonSchema.safeParse({
    kind: "local",
    hostId: range.hostId,
    path: range.path,
    base: range.base,
    head: range.head,
  });
  return {
    headRefOid: range.head,
    baseRefName: range.base,
    comparison: comparison.success ? comparison.data : null,
    files: read.files.map((file): ChangedFile => {
      const patch = file.truncated ? null : hunks(file.patch);
      const { additions, deletions } = countLines(patch);
      return {
        path: file.path,
        previousPath: file.previousPath,
        status: STATUS[file.kind] ?? "changed",
        additions,
        deletions,
        patch,
        viewed: "unviewed",
        generated: isGenerated(file.path, patch, rules),
      };
    }),
  };
}

/**
 * A git patch's hunks without its file header, as GitHub hands them out.
 * Null when there are none: a binary file, or a mode change alone.
 */
export function hunks(patch: string): string | null {
  const start = patch.startsWith("@@") ? 0 : patch.indexOf("\n@@");
  if (start < 0) return null;
  const body = patch.slice(start === 0 ? 0 : start + 1).replace(/\n$/, "");
  return body === "" ? null : body;
}

function countLines(patch: string | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch?.split("\n") ?? []) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** A locator speeds later reads; a cache-write failure must not hide a readable branch. */
export async function rememberBranch(
  bb: BbPluginApi,
  store: Store,
  branch: LocalBranch,
): Promise<void> {
  try {
    await store.rememberBranch(branch);
  } catch (error) {
    bb.log.warn(`Could not remember branch location: ${String(error)}`);
  }
}
