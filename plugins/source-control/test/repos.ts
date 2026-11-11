/**
 * The repositories the provider tests share, built under an isolated root:
 * a bare `origin`, a plain clone on branch X with one commit pushed and one
 * not, and a GitButler workspace with the same X applied in the same state.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertIsolated } from "./isolate.ts";

export const BRANCH = "X";

export type Repos = {
  origin: string;
  plain: string;
  /** Null when this machine has no `but`. */
  gitbutler: string | null;
  base: string;
  pushed: string;
  unpushed: string;
};

/** Git run as someone else would, such as an agent in a terminal: not one of the host's processes. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function but(cwd: string, root: string, ...args: string[]): string {
  assertIsolated(root);
  return execFileSync("but", [...args, "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function ref(cwd: string, name: string): string | null {
  try {
    return git(cwd, "rev-parse", "--verify", "--quiet", `${name}^{commit}`).trim();
  } catch {
    return null;
  }
}

async function commitFile(cwd: string, file: string, content: string, message: string) {
  await writeFile(join(cwd, file), content);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

/** `dir` holds the repositories; `root` stays the isolated root `but` checks against. */
export async function buildRepos(root: string, withButler: boolean, dir = root): Promise<Repos> {
  await mkdir(dir, { recursive: true });
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const plain = join(dir, "plain");
  const gitbutler = join(dir, "gitbutler");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  await mkdir(seed);
  git(seed, "init", "--quiet", "--initial-branch=main", ".");
  await writeFile(join(seed, ".gitignore"), "build/\n");
  git(seed, "add", ".gitignore");
  const base = await commitFile(seed, "base.txt", "base\n", "chore: base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "--quiet", "origin", "main");

  git(dir, "clone", "--quiet", origin, plain);
  git(plain, "switch", "--quiet", "-c", BRANCH);
  const pushed = await commitFile(plain, "one.txt", "one\n", "feat: one\n\nWith a body.");
  git(plain, "push", "--quiet", "-u", "origin", BRANCH);
  const unpushed = await commitFile(plain, "two.txt", "two\n", "feat: two");

  if (!withButler) return { origin, plain, gitbutler: null, base, pushed, unpushed };
  git(dir, "clone", "--quiet", origin, gitbutler);
  git(gitbutler, "fetch", "--quiet", plain, `${BRANCH}:${BRANCH}`);
  git(gitbutler, "branch", "--quiet", `--set-upstream-to=origin/${BRANCH}`, BRANCH);
  but(gitbutler, root, "apply", BRANCH);
  const head = git(gitbutler, "symbolic-ref", "HEAD").trim();
  if (head !== "refs/heads/gitbutler/workspace")
    throw new Error(`but apply left HEAD at ${head}, not GitButler's workspace.`);
  return { origin, plain, gitbutler, base, pushed, unpushed };
}
