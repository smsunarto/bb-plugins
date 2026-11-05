import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { promisify } from "node:util";
import { reviewCheckoutContract } from "./lib/review-checkout-contract";

const exec = promisify(execFile);
async function git(source: string, args: string[], signal: AbortSignal, timeout = 120_000) {
  const result = await exec("git", ["-C", source, ...args], {
    signal,
    timeout,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}
const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

/** `git@github.com:Org/Repo.git`, `https://github.com/org/repo` → `github.com/org/repo`. */
export function remoteKey(url: string) {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

async function originUrl(repo: string) {
  const config = await readFile(path.join(repo, ".git", "config"), "utf8").catch(() => "");
  const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
  return /^\s*url\s*=\s*(.+?)\s*$/m.exec(section)?.[1] ?? null;
}

async function childDirectories(parent: string) {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name));
}

/**
 * Pick the clone a review worktree hangs off: BB's checkout when the machine has
 * one, else a clone already on the machine (a warm image's `~/<repo>` or
 * `~/git/<repo>`), else a blob-less partial clone owned by Slopcop.
 */
export async function resolveSource(
  input: z.infer<typeof reviewCheckoutContract.resolveSource.input>,
  signal: AbortSignal,
  home = os.homedir(),
  runGit: typeof git = git,
) {
  if (input.preferred) return { source: input.preferred };
  const key = remoteKey(input.remote);
  const owned = path.join(home, ".slopcop", "sources", key.replace(/[^a-z0-9._-]+/g, "-"));
  const candidates = [
    owned,
    ...(await childDirectories(home)),
    ...(await childDirectories(path.join(home, "git"))),
  ];
  const origins = await Promise.all(candidates.map(originUrl));
  const match = candidates.find((_, index) => {
    const origin = origins[index];
    return origin !== null && origin !== undefined && remoteKey(origin) === key;
  });
  if (match) return { source: match };

  // Clone beside the final path and rename into place, so an interrupted clone
  // never looks like a usable source and a concurrent winner is reused.
  await mkdir(path.dirname(owned), { recursive: true });
  const staging = await mkdtemp(`${owned}.partial-`);
  try {
    await runGit(
      staging,
      ["clone", "--filter=blob:none", "--no-checkout", input.remote, "."],
      signal,
      540_000,
    );
    await rename(staging, owned).catch(async (error) => {
      if (!(await exists(path.join(owned, ".git")))) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { source: owned };
}

export async function prepareCheckout(
  input: z.infer<typeof reviewCheckoutContract.prepare.input>,
  signal: AbortSignal,
  runGit: typeof git = git,
) {
  if (await exists(input.path)) {
    const head = await runGit(input.path, ["rev-parse", "HEAD"], signal);
    if (head !== input.head) throw new Error("Existing review worktree has a different HEAD");
    return { path: input.path };
  }
  // A reused clone can predate the PR, so refresh the base branch the reviewer
  // diffs against along with the pinned head.
  const refspecs = [`+refs/pull/${input.number}/head:${input.ref}`];
  if (input.base) refspecs.push(`+refs/heads/${input.base}:refs/remotes/origin/${input.base}`);
  await runGit(input.source, ["fetch", "--no-tags", "origin", ...refspecs], signal);
  const head = await runGit(input.source, ["rev-parse", input.ref], signal);
  if (head !== input.head)
    throw new Error("PR head changed before checkout; dispatch a fresh review");
  await mkdir(path.dirname(input.path), { recursive: true });
  await runGit(input.source, ["worktree", "add", "--detach", input.path, input.head], signal);
  return { path: input.path };
}

export default experimental_defineHostEntry({
  contract: reviewCheckoutContract,
  handlers: {
    resolveSource(input, { signal }) {
      return resolveSource(input, signal);
    },
    prepare(input, { signal }) {
      return prepareCheckout(input, signal);
    },
    async remove(input, { signal }) {
      if (await exists(input.path)) {
        // Refuse to discard a dirty worktree; preserve unexpected edits for inspection.
        await git(input.source, ["worktree", "remove", input.path], signal);
      }
      await git(input.source, ["update-ref", "-d", input.ref], signal);
      return {};
    },
  },
});
