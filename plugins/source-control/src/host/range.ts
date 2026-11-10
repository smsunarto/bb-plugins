/**
 * A Change's files, patches and commits between two commits of a checkout,
 * read with plain git: a GitButler workspace's branches are ordinary commits
 * too, so one reader serves both providers. Revisions are immutable, so the
 * server reads each once.
 */
import type { Commit, FileChange } from "../core/change.ts";
import type { ChangeFile } from "../core/review.ts";
import { optionalGit, runGit } from "./cli.ts";
import { DIFF_OPTIONS, MAX_PATCH_CHARS, logCommits } from "./git-workspace.ts";
import { patchesFromGit, type PatchSet } from "./parse.ts";

/** A base the server names by branch: `branch:<name>`, or `branch:` for the remote's default branch. */
export const BRANCH_BASE = "branch:";

/** The remote a checkout compares with: `origin`, or its only remote. */
async function compareRemote(cwd: string, signal: AbortSignal): Promise<string | null> {
  const remotes = ((await optionalGit(cwd, ["remote"], signal)) ?? "").split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : null;
}

/**
 * The commit a base names. A commit id is itself. `branch:<name>` is that
 * branch on the remote, else the remote's default branch: its `HEAD`, else
 * `main`, else `master`, as a checkout added by hand rather than cloned has
 * no `HEAD` for its remote. Null when none of them exists.
 */
export async function resolveBase(
  cwd: string,
  base: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!base.startsWith(BRANCH_BASE)) return base;
  const remote = await compareRemote(cwd, signal);
  if (!remote) return null;
  const named = base.slice(BRANCH_BASE.length);
  const head = await optionalGit(
    cwd,
    ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`],
    signal,
  );
  const candidates = [
    ...(named ? [`refs/remotes/${remote}/${named}`] : []),
    ...(head ? [head] : []),
    `refs/remotes/${remote}/main`,
    `refs/remotes/${remote}/master`,
  ];
  for (const ref of candidates) {
    const id = await optionalGit(
      cwd,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      signal,
    );
    if (id) return id;
  }
  return null;
}

/** A range as git reads it: what `head` adds since it left `base`. */
const range = (base: string, head: string) => `${base}...${head}`;

const KINDS: Record<string, FileChange["kind"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "modified",
};

/** `git diff --name-status -z` records: a status, then one path, or two for a rename or copy. */
export function parseNameStatus(
  output: string,
): { kind: FileChange["kind"]; path: string; previousPath: string | null }[] {
  const fields = output.split("\0");
  const files: { kind: FileChange["kind"]; path: string; previousPath: string | null }[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    if (status === "") continue;
    const kind = KINDS[status[0]!] ?? "modified";
    if (kind === "renamed" || kind === "copied") {
      const previousPath = fields[index++] ?? "";
      files.push({ kind, path: fields[index++] ?? "", previousPath });
    } else files.push({ kind, path: fields[index++] ?? "", previousPath: null });
  }
  return files.filter((file) => file.path !== "");
}

/**
 * `git diff --numstat -z` records: `added\tdeleted\tpath`, or for a rename
 * `added\tdeleted\t` followed by the old and new paths. Binary files count `-`.
 */
export function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const fields = output.split("\0");
  const sizes = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++] ?? "";
    if (record === "") continue;
    const [added = "", deleted = "", path = ""] = record.split("\t");
    let name = path;
    if (path === "") {
      index++; // the old path
      name = fields[index++] ?? "";
    }
    const binary = added === "-" || deleted === "-";
    sizes.set(name, {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return sizes;
}

export async function rangeFiles(
  cwd: string,
  base: string,
  head: string,
  signal: AbortSignal,
): Promise<ChangeFile[]> {
  const args = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", "-z"];
  const [names, numstat] = await Promise.all([
    runGit(cwd, [...args, "--name-status", range(base, head), "--"], signal),
    runGit(cwd, [...args, "--numstat", range(base, head), "--"], signal),
  ]);
  const sizes = parseNumstat(numstat);
  return parseNameStatus(names).map((file) =>
    Object.assign(file, sizes.get(file.path) ?? { additions: 0, deletions: 0, binary: false }),
  );
}

export async function rangePatches(
  cwd: string,
  base: string,
  head: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<PatchSet> {
  // A rename's old path is part of its patch only when it is in the pathspec too.
  const output = await runGit(cwd, [...DIFF_OPTIONS, range(base, head), "--", ...paths], signal);
  return patchesFromGit(output, MAX_PATCH_CHARS);
}

export function rangeCommits(
  cwd: string,
  base: string,
  head: string,
  signal: AbortSignal,
): Promise<Commit[]> {
  return logCommits(cwd, `${base}..${head}`, signal);
}
