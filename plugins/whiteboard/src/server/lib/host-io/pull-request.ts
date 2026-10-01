import { HOST_TIMEOUT_MS } from "../../../shared/contracts/host-contract.ts";
import type * as upstream from "../../../shared/node/vendor/review/src/review-api/pull-request.ts";
import { type HostRoute, invokeHost } from "./client.ts";

/**
 * Server facade for `review-api/pull-request` (design §3.1). The upstream
 * functions run here unchanged; their only machine access is
 * `PullRequestDeps.run`, and the default `run` executes on the repository's
 * host with that user's gh and git credentials. `fetch` (the public GitHub
 * API fallback) is machine-independent and stays on the server. Injected
 * deps (specs, `LocalReviewData.options.pullRequests`) run as given.
 */
export type {
  PullRequestDeps,
  PullRequestRecord,
  RunCommand,
} from "../../../shared/node/vendor/review/src/review-api/pull-request.ts";
export {
  fetchPullRequest,
  githubRemotes,
  pullRequestAddress,
  pullRequestRefs,
  readPullRequest,
} from "../../../shared/node/vendor/review/src/review-api/pull-request.ts";

/** The checkout a command names: its `cwd`, or the `--git-dir`, `-C` or `-R` argument. */
export function commandRoute(args: readonly string[], cwd?: string): HostRoute {
  if (cwd) return { rootPath: cwd };
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === "--git-dir" || args[index] === "-C" || args[index] === "-R")
      return { rootPath: args[index + 1]! };
  }
  return {};
}

export const defaultPullRequestDeps: typeof upstream.defaultPullRequestDeps = {
  run: async (file, args, options) =>
    (await invokeHost(
      "pull-request",
      "run",
      [file, args, options],
      commandRoute(args, options.cwd),
      { timeoutMs: Math.min(options.timeoutMs + 5_000, HOST_TIMEOUT_MS.long) },
    )) as string,
  fetch: (input, init) => fetch(input, init),
};
