/**
 * The two workspace providers behind one host contract. A checkout whose
 * HEAD is one of GitButler's own is a GitButler workspace, read and written
 * through `but`; any other, or any checkout read as plain git, through git.
 * Both answer in the same `WorkspaceValue` shape.
 */
import {
  findBranch,
  type Patches,
  type PatchSource,
  type Problem,
  type Revision,
  type VcsAction,
  type VcsResult,
  type WorkspaceValue,
} from "../core/change.ts";
import type { HostFailure, ReadAs } from "../contract/host.ts";
import { runButWrite } from "./actions.ts";
import { readButPatches, readButWorkspace } from "./but-workspace.ts";
import { readCheckout, type Checkout } from "./checkout.ts";
import { ToolMissingError } from "./cli.ts";
import { runGitWrite } from "./git-actions.ts";
import { readGitPatches, readGitWorkspace } from "./git-workspace.ts";

export type ProviderKind = WorkspaceValue["provider"];

type Provider = {
  read(checkout: Checkout, signal: AbortSignal): Promise<WorkspaceValue>;
  patches(
    checkout: Checkout,
    source: PatchSource,
    signal: AbortSignal,
  ): Promise<Patches & { truncated: boolean }>;
  write(cwd: string, action: VcsAction, signal: AbortSignal): Promise<VcsResult>;
};

export const providers: Readonly<Record<ProviderKind, Provider>> = {
  git: { read: readGitWorkspace, patches: readGitPatches, write: runGitWrite },
  gitbutler: { read: readButWorkspace, patches: readButPatches, write: runButWrite },
};

/** What a path is, and which provider reads it. */
export type Resolved =
  | { state: "not-git" }
  | { state: "detached"; checkout: Checkout }
  | { state: "checkout"; checkout: Checkout; provider: ProviderKind };

export async function resolveCheckout(
  path: string,
  readAs: ReadAs,
  signal: AbortSignal,
): Promise<Resolved> {
  const checkout = await readCheckout(path, signal);
  if (checkout === null) return { state: "not-git" };
  if (readAs === "auto" && checkout.gitbutler)
    return { state: "checkout", checkout, provider: "gitbutler" };
  if (checkout.branch === null) return { state: "detached", checkout };
  return { state: "checkout", checkout, provider: "git" };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A read's failure as the contract names it. */
export function hostFailure(error: unknown): HostFailure {
  if (error instanceof ToolMissingError)
    return { code: error.tool === "but" ? "but-missing" : "git-missing", message: error.message };
  return { code: "failed", message: message(error) };
}

/** A write's failure as a facet problem. The server names the host. */
export function problemOf(error: unknown): Problem {
  if (error instanceof ToolMissingError)
    return { kind: "tool-missing", tool: error.tool, host: "host", detail: error.message };
  return { kind: "failed", site: "host", detail: message(error) };
}

/**
 * Why the checkout is no longer at the revision the write was asked for, or
 * null when it still is. Push and Land name a branch whose head must be
 * unchanged; Pull and Land bring in a target whose head, as last fetched,
 * must be the one the reader saw.
 */
export function revisionConflict(
  value: WorkspaceValue,
  action: VcsAction,
  expected: Revision,
): string | null {
  if (action.kind !== "pull") {
    const branch = findBranch(value, action.branch);
    if (!branch) return `${action.branch} is no longer in this checkout.`;
    if (branch.head !== expected.head)
      return `${action.branch} moved since it was read: its head is now ${branch.head ?? "empty"}.`;
  }
  if (action.kind !== "push") {
    const head = value.target?.head ?? null;
    if (head !== expected.target)
      return `The target moved since it was read: it is now at ${head ?? "nothing"}.`;
  }
  return null;
}

/**
 * One write, made only while the checkout is still at `expected`. The
 * comparison reads the checkout first, before any fetch, so a stale reader
 * changes nothing. Never retried.
 */
export async function act(
  checkout: Checkout,
  provider: ProviderKind,
  action: VcsAction,
  expected: Revision,
  signal: AbortSignal,
): Promise<VcsResult> {
  try {
    const value = await providers[provider].read(checkout, signal);
    const conflict = revisionConflict(value, action, expected);
    if (conflict !== null) return { status: "conflict", detail: conflict };
    return await providers[provider].write(checkout.path, action, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: "failed", problem: problemOf(error) };
  }
}
