import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { reviewHostContract } from "../shared/host-contract.ts";
import type { ReviewRequest, PinnedTarget } from "../shared/schema.ts";

const exec = promisify(execFile);
async function command(cwd: string, program: string, args: string[], signal: AbortSignal) {
  const { stdout } = await exec(program, args, {
    cwd,
    signal,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: [
        process.env.PATH,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        join(homedir(), ".local/bin"),
        join(homedir(), ".cargo/bin"),
      ]
        .filter(Boolean)
        .join(delimiter),
    },
  });
  return stdout;
}
async function git(cwd: string, args: string[], signal: AbortSignal) {
  return command(cwd, "git", ["-c", "core.quotePath=false", ...args], signal);
}
async function commit(cwd: string, ref: string, signal: AbortSignal) {
  const sha = (
    await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)
  ).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha))
    throw new Error("Revision did not resolve to an immutable commit");
  return sha;
}
export function requireSupportedGit(version: string) {
  const match = /^git version (\d+)\.(\d+)/.exec(version.trim());
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 41))
    throw new Error(
      `Review requires Git 2.41 or newer for pinned attributes; this host reports ${version.trim()}`,
    );
}
export function page(text: string, offset: number) {
  const end = Math.min(offset + 16000, text.length);
  return {
    text: text.slice(offset, end),
    nextOffset: end < text.length ? end : null,
    totalLength: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}
const workspaceSchema = z.object({
  stacks: z.array(
    z.object({
      branches: z.array(
        z.object({
          name: z.string(),
          commits: z.array(
            z.object({
              commitId: z.string().regex(/^[a-f0-9]{40,64}$/),
              conflicted: z.boolean().nullable().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
});
export function branchCommits(payload: unknown, branch: string) {
  const state = workspaceSchema.parse(payload);
  const selected = state.stacks
    .flatMap((stack) => stack.branches)
    .find((item) => item.name === branch);
  if (!selected)
    throw new Error("Select an applied GitButler branch, or supply explicit base/head commits");
  if (selected.commits.length === 0)
    throw new Error(
      "This branch has no checkpointed changes. Commit only this workstream's selected changes first",
    );
  if (selected.commits.some((item) => item.conflicted))
    throw new Error("Resolve this branch's conflicted commits before review");
  return { newest: selected.commits[0]!.commitId, oldest: selected.commits.at(-1)!.commitId };
}
export function publicationBase(payload: unknown) {
  return z
    .object({ mergeBase: z.object({ commitId: z.string().regex(/^[a-f0-9]{40,64}$/) }) })
    .parse(payload).mergeBase.commitId;
}
export function validatePublicationBase(payload: unknown, base: string) {
  if (base !== publicationBase(payload))
    throw new Error(
      "Publication review must start at the GitButler workspace merge base to cover the entire selected chain; use segment scope for a narrower range",
    );
}
function unavailableGitButler(error: unknown) {
  const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return (
    value?.code === "ENOENT" ||
    [value?.stdout, value?.stderr].some(
      (text) => typeof text === "string" && text.includes("setup_required"),
    )
  );
}
async function explicitPublicationBase(
  repositoryPath: string,
  target: { base: string; head: string; upstream?: string },
  base: string,
  head: string,
  signal: AbortSignal,
) {
  let state: unknown;
  try {
    state = JSON.parse(await command(repositoryPath, "but", ["status", "--json"], signal));
  } catch (error) {
    if (!unavailableGitButler(error)) throw error;
    state = null;
  }
  if (state === null) {
    if (!target.upstream)
      throw new Error(
        "Plain Git publication review requires a declared upstream ref, for example --upstream origin/main, with --base and --head",
      );
    const ref = (
      await git(
        repositoryPath,
        ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", target.upstream],
        signal,
      )
    ).trim();
    if (!/^refs\/(heads|remotes)\//.test(ref))
      throw new Error(
        "Publication upstream must name a branch or remote-tracking ref, not a commit",
      );
    const upstream = await commit(repositoryPath, target.upstream, signal);
    const expected = (await git(repositoryPath, ["merge-base", upstream, head], signal)).trim();
    if (base !== expected || base === head)
      throw new Error(
        "Publication base must be the merge base with the declared destination, and the candidate must introduce changes",
      );
    return;
  }
  validatePublicationBase(state, base);
}
export async function snapshot(
  environmentPath: string,
  target: NonNullable<ReviewRequest["target"]>,
  signal: AbortSignal,
  scope: "segment" | "publication" = "segment",
): Promise<PinnedTarget> {
  requireSupportedGit(await git(environmentPath, ["--version"], signal));
  const repositoryPath = (
    await git(environmentPath, ["rev-parse", "--show-toplevel"], signal)
  ).trim();
  let base: string,
    head: string,
    branch: string | null = null;
  if ("branch" in target) {
    branch = target.branch;
    const state = JSON.parse(await command(repositoryPath, "but", ["status", "--json"], signal));
    const selected = branchCommits(state, branch);
    head = await commit(repositoryPath, `refs/heads/${branch}`, signal);
    if (head !== selected.newest)
      throw new Error("Branch changed during target resolution. Retry with its new checkpoint");
    base =
      scope === "publication"
        ? await commit(repositoryPath, publicationBase(state), signal)
        : await commit(repositoryPath, `${selected.oldest}^`, signal);
  } else {
    [base, head] = await Promise.all([
      commit(repositoryPath, target.base, signal),
      commit(repositoryPath, target.head, signal),
    ]);
  }
  if (scope === "publication" && !("branch" in target)) {
    await explicitPublicationBase(repositoryPath, target, base, head, signal);
  }
  await git(repositoryPath, ["merge-base", "--is-ancestor", base, head], signal);
  const identities = await git(
    repositoryPath,
    ["log", "--format=%an <%ae>%x09%s", `${base}..${head}`, "--"],
    signal,
  );
  const tip = await git(repositoryPath, ["show", "-s", "--format=%an <%ae>%x09%s", head], signal);
  if (/GitButler Workspace Commit|gitbutler@gitbutler\.com/i.test(identities + tip))
    throw new Error(
      "GitButler workspace commits are combined workspace state, not a review candidate",
    );
  return { repositoryPath, branch, base, head };
}

export default experimental_defineHostEntry({
  contract: reviewHostContract,
  handlers: {
    snapshot: ({ environmentPath, target, scope }, { signal }) =>
      snapshot(environmentPath, target, signal, scope),
    async read({ target, section, path, side, offset }, { signal }) {
      let text: string;
      if (section === "diff")
        text = await git(
          target.repositoryPath,
          [
            `--attr-source=${target.head}`,
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--submodule=short",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            target.base,
            target.head,
            "--",
          ],
          signal,
        );
      else if (section === "tree")
        text = await git(
          target.repositoryPath,
          ["ls-tree", "-r", "--name-only", side === "base" ? target.base : target.head],
          signal,
        );
      else {
        if (
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((part) => part === ".." || part === "." || !part) ||
          Array.from(path).some((char) => char.charCodeAt(0) < 32)
        )
          throw new Error("Use a repository-relative pinned source path");
        text = await git(
          target.repositoryPath,
          ["show", `${side === "base" ? target.base : target.head}:${path}`],
          signal,
        );
      }
      return page(text, offset);
    },
  },
});
