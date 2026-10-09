import type {
  Actor,
  ChecksState,
  PrState,
  ReviewDecision,
  ReviewState,
} from "../../shared/schema.ts";

/*
 * The GitHub GraphQL vocabulary every query here shares, and its mapping to
 * the plugin's schema. Responses are typed by hand from what the queries
 * select, and checked against recorded responses in the tests.
 */

export type GqlActor = { login: string; avatarUrl?: string | null } | null;

export type GqlPageInfo = { hasNextPage: boolean; endCursor: string | null };

export function actor(node: GqlActor | undefined): Actor | null {
  return node ? { login: node.login, avatarUrl: node.avatarUrl ?? null } : null;
}

export function prState(state: string): PrState {
  if (state === "MERGED") return "merged";
  return state === "CLOSED" ? "closed" : "open";
}

const DECISIONS: Record<string, ReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

export function reviewDecision(decision: string | null): ReviewDecision | null {
  return decision === null ? null : (DECISIONS[decision] ?? null);
}

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

export function reviewState(state: string): ReviewState {
  return REVIEW_STATES[state] ?? "commented";
}

/** A commit's `statusCheckRollup.state`. Null when the commit has no checks. */
export function rollupState(state: string | null | undefined): ChecksState | null {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

/**
 * Follows a GraphQL connection past its first page. `page(after)` fetches
 * the page after a cursor. Stops at `maxPages` so a runaway connection
 * cannot hold a request open.
 */
export async function remainingPages<T>(
  first: { pageInfo: GqlPageInfo; nodes: T[] },
  page: (after: string) => Promise<{ pageInfo: GqlPageInfo; nodes: T[] }>,
  maxPages = 10,
): Promise<T[]> {
  const nodes = [...first.nodes];
  let info = first.pageInfo;
  for (let fetched = 1; info.hasNextPage && info.endCursor && fetched < maxPages; fetched++) {
    const next = await page(info.endCursor);
    nodes.push(...next.nodes);
    info = next.pageInfo;
  }
  return nodes;
}

/** `repos/<owner>/<repo>` for a REST path, each part escaped so it stays one segment. */
export function restRepo(owner: string, repo: string): string {
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
