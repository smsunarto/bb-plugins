import { QueryClient } from "@tanstack/react-query";

/**
 * One cache for every mount of the panel. The boundary's own client is
 * cleared whenever the panel unmounts, so switching shelf tabs used to throw
 * away every `but` result and start over from "Loading workspace…".
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The workspace already retries every ten seconds on its own. The
      // default ladder only added seven more seconds of spinner before the
      // reader was told anything had gone wrong.
      retry: 1,
    },
  },
});

/**
 * Options for a query keyed by commit id. The id names the content, so the
 * answer never goes stale. It is still dropped after half an hour unobserved,
 * so a long browsing session does not hold every diff it ever opened.
 */
export const COMMIT_QUERY = { staleTime: Number.POSITIVE_INFINITY, gcTime: 30 * 60_000 } as const;
