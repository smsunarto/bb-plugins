import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const gitButlerHostContract = defineRpcContract({
  branchSummary: {
    input: z.object({ cwd: z.string().trim().min(1) }),
    output: z.object({
      label: z.string().nullable(),
    }),
  },
  githubRepoContext: {
    input: z.object({ cwd: z.string().trim().min(1) }).strict(),
    output: z
      .object({
        owner: z.string().nullable(),
        repo: z.string().nullable(),
      })
      .strict(),
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

  if (branchNames.length === 0) return null;

  return {
    label: branchNames.length === 1 ? branchNames[0] : `${branchNames.length} GitButler branches`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
