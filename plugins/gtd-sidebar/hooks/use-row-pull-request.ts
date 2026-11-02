import { useMemo } from "react";
import { experimental_useRpcKeyedQuery as useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import {
  GITBUTLER_PLUGIN_ID,
  GITHUB_PR_STATUS_PLUGIN_ID,
  gitbutlerPullRequestsContract,
  githubPrStatusContract,
  type RowPullRequest,
} from "../lib/pull-requests";

const NO_KEYS: readonly string[] = [];

function useKeys(key: string | null): readonly string[] {
  return useMemo(() => (key === null ? NO_KEYS : [key]), [key]);
}

/**
 * The pull request for a row: its thread's own GitButler branch's, from the
 * GitButler plugin, else its environment's checked-out branch's, from GitHub
 * PR Status. Rows that mount in the same render share one batched read per
 * plugin, and each plugin rechecks a row while it is on screen. A query
 * error, a missing plugin, `absent` and `unavailable` all read as no pull
 * request.
 */
export function useRowPullRequest(
  threadId: string,
  environmentId: string | null,
): RowPullRequest | null {
  const threadKeys = useKeys(environmentId === null ? null : threadId);
  const environmentKeys = useKeys(environmentId);
  const gitbutler = useRpcKeyedQuery({
    pluginId: GITBUTLER_PLUGIN_ID,
    contract: gitbutlerPullRequestsContract,
    method: "threadPullRequests",
    keys: threadKeys,
    enabled: environmentId !== null,
  });
  const bundled = useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusContract,
    method: "pullRequests",
    keys: environmentKeys,
    enabled: environmentId !== null,
  });
  if (environmentId === null) return null;
  const own = gitbutler.data?.[threadId];
  if (own?.outcome === "available") return own.pullRequest;
  const row = bundled.data?.[environmentId];
  return row?.outcome === "available" ? row.pullRequest : null;
}
