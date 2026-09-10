import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const gitButlerHostContract = defineRpcContract({
  branchSummary: {
    input: z.object({ cwd: z.string().trim().min(1) }),
    output: z.object({
      label: z.string().nullable(),
      branchNames: z.array(z.string().trim().min(1)).max(16).default([]),
    }),
  },
});

export interface GitButlerBranchSummary {
  label: string;
  branchNames: string[];
}

/**
 * Read the applied virtual branches from `but status --json`.
 *
 * GitButler can apply several branches at once. One branch gets its real name;
 * several get a count because the workspace has no single truthful branch.
 */
export function parseGitButlerBranchSummary(stdout: string): GitButlerBranchSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!isRecord(value) || !Array.isArray(value.stacks)) return null;

  const branchNames = [
    ...new Set(
      value.stacks.flatMap((stack) => {
        if (!isRecord(stack) || !Array.isArray(stack.branches)) return [];
        return stack.branches.flatMap((branch) => {
          if (!isRecord(branch) || typeof branch.name !== "string") return [];
          const name = branch.name.trim();
          return name.length === 0 ? [] : [name];
        });
      }),
    ),
  ];

  const firstBranch = branchNames[0];
  if (firstBranch === undefined) return null;

  return {
    label: branchNames.length === 1 ? firstBranch : `${branchNames.length} GitButler branches`,
    branchNames,
  };
}

/** Prefer a confirmed GitButler label over bb's possibly stale branch metadata. */
export function resolveSidebarBranchLabel(
  branchName: string | null,
  environmentId: string | null,
  gitButlerLabels: ReadonlyMap<string, string>,
): string | null {
  if (environmentId === null) return branchName;
  return gitButlerLabels.get(environmentId) ?? branchName;
}

const GITBUTLER_WORKSPACE_REF = "gitbutler/workspace";
const GITBUTLER_COUNT_LABEL = /^\d+ GitButler branches$/u;

/**
 * Names that can match a GitHub head ref. The sidebar display label for a
 * multi-branch GitButler workspace is a count, and bb's raw ref is
 * `gitbutler/workspace` — both of those fail PR matching. The host's parsed
 * virtual-branch names are the ones that can hit.
 */
export function gitButlerBranchNamesFor(
  branchName: string | null,
  environmentId: string | null,
  gitButlerBranches: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (environmentId !== null) {
    const fromHost = gitButlerBranches.get(environmentId);
    if (fromHost !== undefined && fromHost.length > 0) {
      return [...fromHost];
    }
  }
  const raw = branchName?.trim() ?? "";
  if (raw.length === 0) return [];
  if (raw === GITBUTLER_WORKSPACE_REF || GITBUTLER_COUNT_LABEL.test(raw)) return [];
  return [raw];
}

export function gitButlerLabelsMatch(
  current: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): boolean {
  if (current === next) return true;
  if (current.size !== next.size) return false;
  for (const [environmentId, label] of next) {
    if (current.get(environmentId) !== label) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
