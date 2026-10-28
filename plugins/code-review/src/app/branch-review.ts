import { useEffect, useRef } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { queryClient } from "./query.ts";
import {
  BRANCH_REVIEW_CHANNEL,
  branchReviewRange,
  branchReviewRangeSchema,
} from "../shared/schema.ts";
import type { ChangedFile, BranchReviewRange } from "../shared/schema.ts";
import { queryKey as rpcQueryKey, useRpcQuery } from "./rpc.ts";

export function withReviewedFiles(
  files: readonly ChangedFile[],
  paths: readonly string[] = [],
): ChangedFile[] {
  const reviewed = new Set(paths);
  return files.map((file) => ({
    ...file,
    viewed: reviewed.has(file.path) ? "viewed" : "unviewed",
  }));
}

/** Shared by the chat card and Changes tab; reconnects also refetch through React Query. */
export function useBranchReviewed(branch: BranchReviewRange) {
  const range = branchReviewRange(branch);
  const queryKey = rpcQueryKey("branchReviewed", range);
  const query = useRpcQuery("branchReviewed", range, { refetchInterval: 30_000 });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") {
      void queryClient.invalidateQueries({ queryKey });
    }
    previous.current = connection;
  }, [connection, queryKey]);
  useRealtime(BRANCH_REVIEW_CHANNEL, (payload) => {
    const parsed = branchReviewRangeSchema.safeParse(payload);
    if (
      parsed.success &&
      parsed.data.id === range.id &&
      parsed.data.base === range.base &&
      parsed.data.head === range.head
    ) {
      // A newer event must supersede an older read already on the wire.
      void queryClient.invalidateQueries({ queryKey });
    }
  });
  return query;
}
