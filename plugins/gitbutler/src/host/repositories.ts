import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Repository } from "../shared/schema.ts";
import { runGit } from "./cli.ts";

/**
 * Repository discovery is deliberately shallow: the environment root when it
 * is itself a worktree, otherwise the immediate children of `repos/`. Deeper
 * scanning would walk arbitrary user trees on every panel open.
 */

export class NoRepositoryError extends Error {}

const REPOS_DIRECTORY = "repos";

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

async function gitTopLevel(candidate: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const output = await runGit(candidate, ["rev-parse", "--show-toplevel"], signal);
    return await realpath(output.trim());
  } catch {
    if (signal.aborted) throw new Error("aborted");
    return undefined;
  }
}

type Discovery = { root: string; repositories: Array<Repository & { path: string }> };

async function discover(environmentPath: string, signal: AbortSignal): Promise<Discovery> {
  const root = await realpath(environmentPath);
  if ((await gitTopLevel(root, signal)) === root) {
    return { root, repositories: [{ key: ".", name: basename(root), path: root }] };
  }

  let reposDirectory: string;
  let entries: string[];
  try {
    reposDirectory = await realpath(resolve(root, REPOS_DIRECTORY));
    entries = await readdir(reposDirectory);
  } catch {
    return { root, repositories: [] };
  }

  const found: Array<Repository & { path: string }> = [];
  for (const entry of entries.sort()) {
    let candidate: string;
    try {
      candidate = await realpath(resolve(reposDirectory, entry));
    } catch {
      continue;
    }
    if (!isInside(root, candidate)) continue;
    if (dirname(candidate) !== reposDirectory) continue;
    if ((await gitTopLevel(candidate, signal)) !== candidate) continue;
    found.push({ key: `${REPOS_DIRECTORY}/${entry}`, name: entry, path: candidate });
  }
  return { root, repositories: found };
}

export async function listRepositories(
  environmentPath: string,
  signal: AbortSignal,
): Promise<Repository[]> {
  const { repositories } = await discover(environmentPath, signal);
  return repositories.map(({ key, name }) => ({ key, name }));
}

/**
 * Resolve a caller-supplied key to a real repository path. The key comes from
 * the browser, so it is re-validated against a fresh scan every call rather
 * than trusted as a path.
 */
export async function resolveRepository(
  environmentPath: string,
  repositoryKey: string | undefined,
  signal: AbortSignal,
): Promise<{ key: string; name: string; path: string }> {
  const { repositories } = await discover(environmentPath, signal);
  if (repositories.length === 0) {
    throw new NoRepositoryError(
      "No Git repository was found at the environment root or under its repos/ directory.",
    );
  }
  if (repositoryKey === undefined) {
    return repositories[0]!;
  }
  const selected = repositories.find((repository) => repository.key === repositoryKey);
  if (!selected) throw new NoRepositoryError("That repository is no longer available.");
  return selected;
}
