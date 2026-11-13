/**
 * Several pull requests of one repository by number, in one GraphQL call:
 * the facts `core/pr-reads.ts` names. Exec-injected and Effect-free, so the
 * server and a checkout's host run the same code.
 *
 * GitHub answers a missing number with an error beside the other pull
 * requests' data, and `gh api graphql` then exits non-zero. Only a missing
 * repository, or an answer with no data, fails the whole read; a missing
 * number is null for that number alone.
 */
import type { Repo } from "../core/ids.ts";
import type { PrStatus } from "../core/pr-reads.ts";
import { classifyFailure, GhError, type Exec, type GhErrorCode } from "./github.ts";
import { countByState } from "./review.ts";

const FIELDS = `
  number url title state isDraft updatedAt headRefName baseRefName
  mergeable mergeStateStatus reviewDecision isInMergeQueue
  autoMergeRequest { enabledAt }
  reviewRequests(first: 0) { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 0) {
    checkRunCountsByState { state count }
    statusContextCountsByState { state count }
  } } } } }`;

/** The query for `count` numbers, aliased `p0`…; numbers go in as variables. */
export function prStatusesQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `, $n${i}: Int!`).join("");
  const fields = Array.from(
    { length: count },
    (_, i) => `p${i}: pullRequest(number: $n${i}) { ${FIELDS} }`,
  ).join("\n    ");
  return `query($owner: String!, $name: String!${vars}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
}

type CountByState = { state?: string; count?: number };
type Node = {
  number?: number;
  url?: string;
  title?: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  updatedAt?: string | null;
  headRefName?: string;
  baseRefName?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus?: string | null;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  isInMergeQueue?: boolean;
  autoMergeRequest?: { enabledAt?: string | null } | null;
  reviewRequests?: { totalCount?: number } | null;
  commits?: {
    nodes?: ({
      commit?: {
        statusCheckRollup?: {
          contexts?: {
            checkRunCountsByState?: CountByState[];
            statusContextCountsByState?: CountByState[];
          };
        } | null;
      };
    } | null)[];
  };
};
type GqlError = { message?: string; type?: string; path?: (string | number)[] };

const REVIEW = new Set(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);
const MERGEABLE = new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);

function statusOf(node: Node): PrStatus | null {
  if (typeof node.number !== "number" || !node.url) return null;
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  return {
    number: node.number,
    url: node.url,
    title: node.title ?? "",
    state: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open",
    isDraft: node.isDraft === true,
    baseRef: node.baseRefName ?? "",
    headRef: node.headRefName ?? "",
    updatedAt: node.updatedAt ?? null,
    mergeable: node.mergeable && MERGEABLE.has(node.mergeable) ? node.mergeable : "UNKNOWN",
    mergeStateStatus: node.mergeStateStatus ?? null,
    reviewDecision:
      node.reviewDecision && REVIEW.has(node.reviewDecision) ? node.reviewDecision : null,
    reviewRequests: node.reviewRequests?.totalCount ?? 0,
    checks: countByState([
      ...(contexts?.checkRunCountsByState ?? []),
      ...(contexts?.statusContextCountsByState ?? []),
    ]),
    autoMerge: node.autoMergeRequest != null,
    inMergeQueue: node.isInMergeQueue === true,
  };
}

function errorCode(type: string | undefined): GhErrorCode {
  switch (type) {
    case "NOT_FOUND":
      return "not-found";
    case "FORBIDDEN":
      return "forbidden";
    case "RATE_LIMITED":
      return "rate-limited";
    default:
      return "failed";
  }
}

/**
 * The pull requests `numbers` names in `repo`, keyed by number; null for a
 * number the repository has no pull request for. Throws a `GhError` when the
 * repository can't be read: "not-found" when this account can't see it, so
 * the caller can try another account.
 */
export async function readPrStatuses(
  exec: Exec,
  repo: Repo,
  numbers: readonly number[],
  signal?: AbortSignal,
): Promise<Record<number, PrStatus | null>> {
  const variables: Record<string, string | number> = { owner: repo.owner, name: repo.name };
  numbers.forEach((number, i) => {
    variables[`n${i}`] = number;
  });
  const result = await exec(["api", "graphql", "--input", "-"], {
    stdin: JSON.stringify({ query: prStatusesQuery(numbers.length), variables }),
    signal,
  });
  let parsed: { data?: { repository?: Record<string, Node | null> | null }; errors?: GqlError[] };
  try {
    parsed = result.stdout.trim() === "" ? {} : JSON.parse(result.stdout);
  } catch {
    parsed = {};
  }
  const repository = parsed.data?.repository;
  if (!repository) {
    const error = parsed.errors?.[0];
    if (error)
      throw new GhError(errorCode(error.type), error.message ?? "GitHub GraphQL request failed.");
    throw classifyFailure(result);
  }
  // A failure that isn't one number's NOT_FOUND (rate limit, timeout) fails the read.
  const fatal = parsed.errors?.find((error) => error.type !== "NOT_FOUND");
  if (fatal)
    throw new GhError(errorCode(fatal.type), fatal.message ?? "GitHub GraphQL request failed.");
  const answer: Record<number, PrStatus | null> = {};
  numbers.forEach((number, i) => {
    const node = repository[`p${i}`];
    answer[number] = node ? statusOf(node) : null;
  });
  return answer;
}
