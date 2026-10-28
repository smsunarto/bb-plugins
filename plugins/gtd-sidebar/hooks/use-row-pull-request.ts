import { useMemo } from "react";
import { experimental_useRpcKeyedQuery as useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import {
  GITHUB_PR_STATUS_PLUGIN_ID,
  githubPrStatusContract,
  type RowPullRequest,
} from "../lib/pull-requests";

const NO_KEYS: readonly string[] = [];

/**
 * The pull request for a row's environment, from GitHub PR Status. Rows that
 * mount in the same render share one batched read, and the plugin rechecks a
 * row while it is on screen. A query error, a missing plugin, `absent` and
 * `unavailable` all read as no pull request.
 */
export function useRowPullRequest(environmentId: string | null): RowPullRequest | null {
  const keys = useMemo(() => (environmentId === null ? NO_KEYS : [environmentId]), [environmentId]);
  const { data } = useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusContract,
    method: "pullRequests",
    keys,
    enabled: environmentId !== null,
  });
  const row = environmentId === null ? undefined : data?.[environmentId];
  return row?.outcome === "available" ? row.pullRequest : null;
}
