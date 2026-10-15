import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Repository } from "../shared/schema.ts";
import { runGit } from "./cli.ts";
import { isGitButlerHead } from "./git-workspace.ts";
import { readOrigin } from "./origin.ts";

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

type Discovery = Array<Repository & { path: string }>;

async function discover(environmentPath: string, signal: AbortSignal): Promise<Discovery> {
  const root = await realpath(environmentPath);
  if ((await gitTopLevel(root, signal)) === root) {
    return [{ key: ".", name: basename(root), path: root }];
  }

  let reposDirectory: string;
  let entries: string[];
  try {
    reposDirectory = await realpath(resolve(root, REPOS_DIRECTORY));
    entries = await readdir(reposDirectory);
  } catch {
    return [];
  }

  // Every call rescans, so the entries are checked at once rather than one
  // git spawn after another. Promise.all keeps the sorted order.
  const checked = await Promise.all(
    entries.sort().map(async (entry) => {
      let candidate: string;
      try {
        candidate = await realpath(resolve(reposDirectory, entry));
      } catch {
        return undefined;
      }
      if (!isInside(root, candidate) || dirname(candidate) !== reposDirectory) return undefined;
      if ((await gitTopLevel(candidate, signal)) !== candidate) return undefined;
      return { key: `${REPOS_DIRECTORY}/${entry}`, name: entry, path: candidate };
    }),
  );
  return checked.filter((repository) => repository !== undefined);
}

export async function listRepositories(
  environmentPath: string,
  signal: AbortSignal,
): Promise<Repository[]> {
  const repositories = await discover(environmentPath, signal);
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
  const repositories = await discover(environmentPath, signal);
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

/**
 * How many paths are checked at once. A machine can hold hundreds of
 * environments, and each check spawns git.
 */
const CHECKS_AT_ONCE = 16;

/** `map` over `items`, at most `CHECKS_AT_ONCE` at a time, in order. */
export async function inBatches<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += CHECKS_AT_ONCE) {
    results.push(...(await Promise.all(items.slice(start, start + CHECKS_AT_ONCE).map(map))));
  }
  return results;
}

/** Expanded worktree discovery never scans arbitrary neighboring directories. */
const MAX_LINKED_CHECKOUTS = 1000;

type BranchCheckout = Discovery[number] & { origin: string | null } & (
    | { kind: "gitbutler" }
    | { kind: "git"; branch: string }
  );

/** NUL fields preserve worktree paths containing whitespace or newlines. */
function registeredWorktrees(output: string, namedOnly = true): string[] {
  const paths: string[] = [];
  for (const record of output.split("\0\0")) {
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (
      path &&
      isAbsolute(path) &&
      (!namedOnly || fields.some((field) => field.startsWith("branch refs/heads/"))) &&
      !fields.some((field) => field === "bare" || field.startsWith("prunable"))
    ) {
      paths.push(path);
      if (namedOnly && paths.length === MAX_LINKED_CHECKOUTS) break;
    }
  }
  return paths;
}

/** Keep bb's root-or-repos-child grammar while filtering unrelated environments without Git. */
async function knownRegistryRoots(
  paths: readonly string[],
  registered: ReadonlySet<string>,
): Promise<Set<string>> {
  const possibleRoots = new Set(registered);
  for (const checkout of registered) {
    const parent = dirname(checkout);
    if (basename(parent) === REPOS_DIRECTORY) possibleRoots.add(dirname(parent));
  }
  const known = (
    await inBatches(paths, (candidate) => realpath(candidate).catch(() => null))
  ).filter((candidate): candidate is string => candidate !== null && possibleRoots.has(candidate));
  return new Set(known);
}

/** Validate one selected path directly against known roots and Git's registry. */
export async function resolveKnownCheckout(
  path: string,
  selection: { paths: readonly string[]; origin: string },
  signal: AbortSignal,
): Promise<Discovery[number]> {
  const canonical = await realpath(path);
  const refuse = () =>
    new NoRepositoryError(
      "That checkout is no longer registered for this repository. Refresh the board.",
    );
  if ((await gitTopLevel(canonical, signal)) !== canonical) throw refuse();
  const listed = await runGit(canonical, ["worktree", "list", "--porcelain", "-z"], signal);
  const registered = new Set(
    (
      await inBatches(registeredWorktrees(listed, false), (candidate) =>
        realpath(candidate).catch(() => null),
      )
    ).filter((candidate) => candidate !== null),
  );
  if (!registered.has(canonical) || (await readOrigin(canonical, signal)) !== selection.origin)
    throw refuse();
  const ownCommon = await runGit(canonical, ["rev-parse", "--git-common-dir"], signal);
  const commonDir = await realpath(resolve(canonical, ownCommon.trim()));
  for (const candidate of await knownRegistryRoots(selection.paths, registered)) {
    const roots = await discover(candidate, signal);
    for (const root of roots) {
      if (!registered.has(root.path) || (await readOrigin(root.path, signal)) !== selection.origin)
        continue;
      const common = await runGit(root.path, ["rev-parse", "--git-common-dir"], signal);
      if ((await realpath(resolve(root.path, common.trim()))) === commonDir)
        return { key: ".", name: basename(canonical), path: canonical };
    }
  }
  throw refuse();
}

/**
 * Named checkouts for the read-only machine list. Alongside bb's known
 * repositories, Git's own worktree registry can name isolated checkouts
 * outside bb environments. Review and mutation callers keep findCheckouts.
 */
export async function findBranchCheckouts(
  paths: readonly string[],
  origin: string,
  signal: AbortSignal,
): Promise<BranchCheckout[]> {
  const found = await inBatches(paths, (path) =>
    discover(path, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return [];
    }),
  );
  const known = new Map(found.flat().map((repository) => [repository.path, repository]));
  const sameOrigin = await inBatches([...known.values()], async (repository) =>
    (await readOrigin(repository.path, signal)) === origin ? repository : undefined,
  );
  const roots = sameOrigin.filter((repository) => repository !== undefined);
  const linked = new Set<string>();
  for (
    let start = 0;
    start < roots.length && linked.size < MAX_LINKED_CHECKOUTS;
    start += CHECKS_AT_ONCE
  ) {
    const registered = await inBatches(roots.slice(start, start + CHECKS_AT_ONCE), (repository) =>
      runGit(repository.path, ["worktree", "list", "--porcelain", "-z"], signal)
        .then(registeredWorktrees)
        .catch((error: unknown) => {
          if (signal.aborted) throw error;
          return [];
        }),
    );
    for (const path of registered.flat()) {
      linked.add(path);
      if (linked.size === MAX_LINKED_CHECKOUTS) break;
    }
  }
  const expanded = await inBatches([...linked], async (path) => {
    const canonical = await gitTopLevel(path, signal);
    // A stale registry entry must not resolve to a parent repository instead.
    if (!canonical || (await realpath(path).catch(() => undefined)) !== canonical) return undefined;
    return { key: ".", name: basename(canonical), path: canonical };
  });
  const unique = new Map(
    [...roots, ...expanded.filter((repository) => repository !== undefined)].map((repository) => [
      repository.path,
      repository,
    ]),
  );
  const matched = await inBatches(
    [...unique.values()],
    async (repository): Promise<BranchCheckout | undefined> => {
      const [head, own] = await Promise.all([
        runGit(repository.path, ["symbolic-ref", "-q", "HEAD"], signal).catch((error: unknown) => {
          if (signal.aborted) throw error;
          return "";
        }),
        readOrigin(repository.path, signal),
      ]);
      const ref = head.trim();
      if (own !== origin || !ref.startsWith("refs/heads/")) return undefined;
      return isGitButlerHead(ref)
        ? { ...repository, origin: own, kind: "gitbutler" }
        : { ...repository, origin: own, kind: "git", branch: ref.slice(11) };
    },
  );
  return matched
    .filter((repository) => repository !== undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The GitButler workspaces among `paths` whose origin is `origin`, or any
 * origin when it is null, each path searched the way an environment is. A
 * path that is gone or holds another repository drops out, and a repository
 * reached by two paths is listed once. A linked worktree is on a branch of
 * its own, so it drops out too.
 */
export async function findCheckouts(
  paths: readonly string[],
  origin: string | null,
  signal: AbortSignal,
): Promise<Array<Discovery[number] & { origin: string | null }>> {
  const found = await inBatches(paths, (path) =>
    discover(path, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return [];
    }),
  );
  const unique = new Map(found.flat().map((repository) => [repository.path, repository]));
  const matched = await inBatches([...unique.values()], async (repository) => {
    const [head, own] = await Promise.all([
      runGit(repository.path, ["symbolic-ref", "-q", "HEAD"], signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return "";
      }),
      readOrigin(repository.path, signal),
    ]);
    const wanted = origin === null || own === origin;
    return isGitButlerHead(head.trim()) && wanted ? { ...repository, origin: own } : undefined;
  });
  return matched
    .filter((repository) => repository !== undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Whether the repository at real path `path` is a GitButler workspace found
 * under one of `paths`, searched the way {@link findCheckouts} searches them.
 */
export async function isKnownWorkspace(
  paths: readonly string[],
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  const found = await inBatches(paths, (known) =>
    discover(known, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return [];
    }),
  );
  if (!found.flat().some((repository) => repository.path === path)) return false;
  const head = await runGit(path, ["symbolic-ref", "-q", "HEAD"], signal).catch(
    (error: unknown) => {
      if (signal.aborted) throw error;
      return "";
    },
  );
  return isGitButlerHead(head.trim());
}
