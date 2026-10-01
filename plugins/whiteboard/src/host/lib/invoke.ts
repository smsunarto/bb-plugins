import { execFile } from "node:child_process";
import type { HostInput, HostModule, HostOutput } from "../../shared/contracts/host-contract.ts";
import * as localVcs from "../../shared/node/vendor/local-vcs/src/index.ts";
import { defaultPullRequestDeps } from "../../shared/node/vendor/review/src/review-api/pull-request.ts";
import * as worktreeSource from "../../shared/node/vendor/review/src/review-api/worktree-source.ts";
import { resolveReviewBranchLinks } from "../../shared/node/vendor/review/src/review-branch-links.ts";
import { ensureReviewPinnedCheckout } from "../../shared/node/vendor/review/src/review-head-checkout.ts";
import { resolveReviewStackLayers } from "../../shared/node/vendor/review/src/review-stack.ts";
import { diffrExecutable } from "../../shared/node/vendor/review/src/server/structural-diff.ts";
import { decodeArgs, failure, hostResult } from "./codec.ts";
import { hostFs } from "./host-fs.ts";

type HostFunction = (args: any[], signal: AbortSignal) => unknown;

/** Spread the decoded arguments into an upstream export. */
const plain =
  (fn: (...args: any[]) => unknown): HostFunction =>
  (args) =>
    fn(...args);

/**
 * The allowlist (design §3.1): every export a server facade sends to the
 * host, by module. Upstream functions run unchanged; a few entries pin the
 * upstream default for a parameter that cannot cross the hop (a function) or
 * thread the call's abort signal into the subprocess.
 */
export const HOST_FUNCTIONS: {
  readonly [M in HostModule]: Readonly<Record<string, HostFunction>>;
} = {
  "local-vcs": {
    detectLocalVcs: plain(localVcs.detectLocalVcs),
    gitCommonDir: plain(localVcs.gitCommonDir),
    resolveRepoContext: plain(localVcs.resolveRepoContext),
    git: ([rootPath, args, options], signal) =>
      localVcs.git(rootPath, args, { ...options, signal }),
    diff: plain(localVcs.diff),
    diffTrees: plain(localVcs.diffTrees),
    diffWorkingTree: plain(localVcs.diffWorkingTree),
    diffFileSummariesTrees: plain(localVcs.diffFileSummariesTrees),
    diffFileSummariesWorkingTree: plain(localVcs.diffFileSummariesWorkingTree),
    listCommitRange: plain(localVcs.listCommitRange),
    listTrackedFilesAtCommit: plain(localVcs.listTrackedFilesAtCommit),
    // The server keeps its own batched reader; the host reads with its own.
    readFileAtCommit: ([input]) => localVcs.readFileAtCommit({ ...input, reader: undefined }),
  },
  "worktree-source": {
    localSourcePath: plain(worktreeSource.localSourcePath),
    workingFiles: plain(worktreeSource.workingFiles),
    inspectWorktree: plain(worktreeSource.inspectWorktree),
    readWorkingFile: plain(worktreeSource.readWorkingFile),
  },
  "pull-request": {
    // `PullRequestDeps.run`: gh and git with the host user's credentials.
    run: plain(defaultPullRequestDeps.run),
  },
  "review-stack": {
    // Upstream default `runGitHubApi` (`gh api` on this host).
    resolveReviewStackLayers: ([subject, reviews]) => resolveReviewStackLayers(subject, reviews),
  },
  "review-branch-links": {
    // Upstream default runner (`git` on this host).
    resolveReviewBranchLinks: ([input]) => resolveReviewBranchLinks(input),
  },
  "review-head-checkout": {
    ensureReviewPinnedCheckout: plain(ensureReviewPinnedCheckout),
  },
  fs: {
    realpath: plain(hostFs.realpath),
    stat: plain(hostFs.stat),
    lstat: plain(hostFs.lstat),
    readFile: plain(hostFs.readFile),
    readlink: plain(hostFs.readlink),
    writeFile: plain(hostFs.writeFile),
    mkdir: plain(hostFs.mkdir),
    exists: plain(hostFs.exists),
    execFile: ([file, args, options], signal) => hostFs.execFile(file, args, options, signal),
  },
};

/** Run one allowlisted host-module export with wire-decoded args (design §3.1). */
export async function invoke(
  input: HostInput<"invoke">,
  signal: AbortSignal,
): Promise<HostOutput<"invoke">> {
  const table = HOST_FUNCTIONS[input.module];
  if (!Object.hasOwn(table, input.fn)) {
    return {
      ok: false,
      error: {
        name: "unknown_function",
        message: `whiteboard: ${input.module}.${input.fn} is not an allowlisted host function.`,
      },
    };
  }
  try {
    return hostResult(await table[input.fn]!(await decodeArgs(input.args), signal));
  } catch (error) {
    return failure(error);
  }
}

/** Whether `file args` starts and exits 0 within 10 s. */
function runs(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (error) => resolve(!error));
  });
}

/** git, jj, gh and diffr discovery for `probe`. `diffr` is the executable that answered. */
export async function probe(): Promise<HostOutput<"probe">> {
  const diffr = diffrExecutable();
  const [git, jj, gh, diffrRuns] = await Promise.all([
    runs("git", ["--version"]),
    runs("jj", ["--version"]),
    runs("gh", ["--version"]),
    runs(diffr, ["--version"]),
  ]);
  return { platform: process.platform, git, jj, gh, diffr: diffrRuns ? diffr : null };
}
