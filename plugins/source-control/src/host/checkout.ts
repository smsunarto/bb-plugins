/**
 * What a path is: not a checkout, or a checkout with its Git directories,
 * branch, head, and remotes. Ported from `readGitCheckout` and
 * `isGitButlerHead` in `plugins/gitbutler/src/host/git-workspace.ts`.
 */
import { realpath } from "node:fs/promises";
import { CommandFailedError, optionalGit, runGitCommand } from "./cli.ts";

export type Checkout = {
  /** The working tree's top level, real path. */
  path: string;
  /** This checkout's own Git directory: `.git`, or a linked worktree's. */
  gitDir: string;
  /** The Git directory every worktree of the repository shares. */
  commonDir: string;
  /** HEAD's symbolic ref, or null when detached. */
  ref: string | null;
  /** The checked-out branch's short name, or null when detached. */
  branch: string | null;
  /** HEAD's commit, or null on an unborn branch. */
  head: string | null;
  /** `remote.origin.url` and `remote.upstream.url`, as configured. */
  remotes: { origin: string | null; upstream: string | null };
  /** HEAD is one of GitButler's own, so `but` owns the workspace. */
  gitbutler: boolean;
};

/** Workspace, edit, and other internal heads belong to GitButler's lifecycle. */
export function isGitButlerHead(ref: string | null): boolean {
  return ref?.startsWith("refs/heads/gitbutler/") ?? false;
}

/** The checkout at `cwd`, or null when it is no Git working tree (or no longer exists). */
export async function readCheckout(cwd: string, signal: AbortSignal): Promise<Checkout | null> {
  const start = await realpath(cwd).catch(() => null);
  if (start === null) return null;
  const located = await runGitCommand(
    start,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
    signal,
  );
  // Not a repository, or a bare one with no working tree.
  if (located.code !== 0) return null;
  const [top, gitDir, commonDir] = located.stdout.split("\n");
  if (!top || !gitDir || !commonDir) return null;
  const [path, own, common] = await Promise.all(
    [top, gitDir, commonDir].map((dir) => realpath(dir)),
  );
  const [ref, head, remotes] = await Promise.all([
    optionalGit(path!, ["symbolic-ref", "-q", "HEAD"], signal),
    optionalGit(path!, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], signal),
    readRemotes(path!, signal),
  ]);
  return {
    path: path!,
    gitDir: own!,
    commonDir: common!,
    ref,
    branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
    head,
    remotes,
    gitbutler: isGitButlerHead(ref),
  };
}

async function readRemotes(path: string, signal: AbortSignal) {
  const settings =
    (await optionalGit(
      path,
      ["config", "--get-regexp", "^remote\\.(origin|upstream)\\.url$"],
      signal,
    )) ?? "";
  const url = (name: string) =>
    settings
      .split("\n")
      .find((line) => line.startsWith(`remote.${name}.url `))
      ?.slice(`remote.${name}.url `.length)
      .trim() || null;
  return { origin: url("origin"), upstream: url("upstream") };
}

/**
 * Refuses when the checkout's branch, HEAD, or remotes moved since `before`,
 * so a write never acts on a checkout the reader did not see.
 */
export async function unchanged(
  before: Checkout,
  signal: AbortSignal,
  now?: Checkout | null,
): Promise<void> {
  const current = now ?? (await readCheckout(before.path, signal));
  if (
    !current ||
    current.ref !== before.ref ||
    current.head !== before.head ||
    current.remotes.origin !== before.remotes.origin ||
    current.commonDir !== before.commonDir
  ) {
    throw new CommandFailedError(
      "The checkout's branch, HEAD, or origin changed. Refresh before trying again.",
    );
  }
}
