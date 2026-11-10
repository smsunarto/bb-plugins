/**
 * The plain-git workspace provider: what a checkout's host reads about the
 * branch it has checked out. Status parsing and remote-branch resolution are
 * ported from `plugins/gitbutler/src/host/git-workspace.ts`.
 */
import type { ExecFileException } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { experimental_execHostFileCallback as execFile } from "@get-bb/plugin-sdk/process";
import { MAX_COMMITS, MAX_UNCOMMITTED, type LocalValue } from "../core/change.ts";
import { githubHome } from "../core/ids.ts";
import type { HostWorkspace } from "../contract/host.ts";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class GitMissingError extends Error {}
export class GitFailedError extends Error {}

type GitResult = { code: number; stdout: string; stderr: string };

function gitResult(error: ExecFileException | null, stdout: string, stderr: string): GitResult {
  if (error?.code === "ENOENT") throw new GitMissingError("git is not installed on this host.");
  const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
  return { code, stdout, stderr };
}

function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<GitResult> {
  return new Promise<GitResult>((settle, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (signal.aborted) return reject(signal.reason);
        try {
          settle(gitResult(error, String(stdout), String(stderr)));
        } catch (failure) {
          reject(failure);
        }
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
  });
}

async function required(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const result = await git(cwd, args, signal);
  if (result.code !== 0)
    throw new GitFailedError(result.stderr.trim().split("\n")[0] || "git failed.");
  return result.stdout;
}

/** stdout trimmed, or null when git exits non-zero (an absent ref or setting). */
async function optional(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  const result = await git(cwd, args, signal);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

type FileChange = LocalValue["uncommitted"][number];

function changeKind(code: string): FileChange["kind"] {
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  return "modified";
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Porcelain v1 is stable, and -z writes paths literally (rename destination first). */
export function parseGitStatus(output: string): { changes: FileChange[]; conflicts: number } {
  const changes: FileChange[] = [];
  let conflicts = 0;
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    if (code === "!!") continue;
    if (CONFLICT_CODES.has(code)) conflicts++;
    changes.push({ path: field.slice(3), kind: changeKind(code) });
    if (code.includes("R") || code.includes("C")) i++;
  }
  return { changes, conflicts };
}

/** `%H\0%s\0` records, newest first. */
export function parseLog(output: string): LocalValue["commits"] {
  const fields = output.split("\0");
  const commits: LocalValue["commits"] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const id = fields[i]!.trim();
    if (id !== "") commits.push({ id, subject: fields[i + 1] ?? "" });
  }
  return commits;
}

/** The remote branch this one compares with: its configured upstream, else the same name on origin. */
async function upstreamOf(
  path: string,
  branch: string,
  signal: AbortSignal,
): Promise<string | null> {
  const configured = await optional(
    path,
    ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`],
    signal,
  );
  for (const ref of [configured, `refs/remotes/origin/${branch}`]) {
    if (
      ref?.startsWith("refs/remotes/") &&
      (await optional(path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal))
    ) {
      return ref;
    }
  }
  return null;
}

/** The commit this branch started from on the default branch, when origin names one. */
async function baseOf(path: string, head: string, signal: AbortSignal): Promise<string | null> {
  const target = await optional(path, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], signal);
  return target ? optional(path, ["merge-base", head, target], signal) : null;
}

export async function readWorkspace(cwd: string, signal: AbortSignal): Promise<HostWorkspace> {
  const path = await realpath(cwd);
  const common = await git(path, ["rev-parse", "--git-common-dir"], signal);
  if (common.code !== 0) return { state: "not-git", path };
  const ref = await optional(path, ["symbolic-ref", "-q", "HEAD"], signal);
  if (!ref?.startsWith("refs/heads/")) return { state: "detached", path };
  const branch = ref.slice("refs/heads/".length);
  const [commonDir, head, origin, upstreamRemote, status] = await Promise.all([
    realpath(resolve(path, common.stdout.trim())),
    optional(path, ["rev-parse", "--verify", "--quiet", "HEAD"], signal),
    optional(path, ["config", "--get", "remote.origin.url"], signal),
    optional(path, ["config", "--get", "remote.upstream.url"], signal),
    required(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal).then(
      parseGitStatus,
    ),
  ]);
  const [upstreamRef, base] = head
    ? await Promise.all([upstreamOf(path, branch, signal), baseOf(path, head, signal)])
    : [null, null];
  const counts = upstreamRef
    ? (
        await required(
          path,
          ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
          signal,
        )
      )
        .trim()
        .split(/\s+/)
        .map(Number)
    : null;
  const commits =
    head && base
      ? parseLog(
          await required(
            path,
            [
              "log",
              "-z",
              "--no-show-signature",
              "--format=%H%x00%s",
              `--max-count=${MAX_COMMITS}`,
              `${base}..${head}`,
              "--",
            ],
            signal,
          ),
        )
      : [];
  const local: LocalValue = {
    path,
    commonDir,
    branch,
    head,
    github: githubHome({ origin, upstream: upstreamRemote }),
    upstream:
      upstreamRef && counts
        ? {
            ref: upstreamRef.slice("refs/remotes/".length),
            ahead: counts[0] ?? 0,
            behind: counts[1] ?? 0,
          }
        : null,
    uncommitted: status.changes.slice(0, MAX_UNCOMMITTED),
    moreUncommitted: Math.max(0, status.changes.length - MAX_UNCOMMITTED),
    conflicted: status.conflicts,
    commits,
  };
  return { state: "branch", local };
}
