/**
 * Options for a query keyed by commit id. The id names the content, so the
 * answer never goes stale. It is still dropped after half an hour unobserved,
 * so a long browsing session does not hold every diff it ever opened.
 */
export const COMMIT_QUERY = { staleTime: Number.POSITIVE_INFINITY, gcTime: 30 * 60_000 } as const;

/** How often an open diff of uncommitted work, or the operation log, is read again. */
export const REFRESH_INTERVAL_MS = 10_000;

/**
 * How often an open panel reads its board unasked. The host says when the
 * repository changes and an agent's turn ends, so this only catches edits
 * to files nobody committed and signals lost on the way. Each read also
 * renews the host's watch on the repository, which lapses without one.
 */
export const SAFETY_POLL_MS = 60_000;

/** Base history commits per page. The first page is also the one kept across reloads. */
export const BASE_HISTORY_PAGE = 60;
