/**
 * Options for a query keyed by commit id. The id names the content, so the
 * answer never goes stale. It is still dropped after half an hour unobserved,
 * so a long browsing session does not hold every diff it ever opened.
 */
export const COMMIT_QUERY = { staleTime: Number.POSITIVE_INFINITY, gcTime: 30 * 60_000 } as const;

/** How often the panel re-reads the workspace, and how long worktree-derived reads stay fresh. */
export const REFRESH_INTERVAL_MS = 10_000;
