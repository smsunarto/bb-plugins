import { useQuery } from "@tanstack/react-query";
import { rpc } from "./rpc.ts";

/** Location hints aid discovery; every surface shares the revision cache by branch id. */
export function useLocalBranch(id: string, threadId?: string) {
  const client = rpc.useClient();
  return useQuery({
    queryKey: rpc.localBranch.queryKey({ id }),
    queryFn: () => client.localBranch({ id, ...(threadId ? { threadId } : {}) }),
    staleTime: 30_000,
    retry: false,
    // A missing branch needs explicit retry or reconnection, not repeated fleet scans.
    refetchInterval: (query) => (query.state.error ? false : 30_000),
  });
}
