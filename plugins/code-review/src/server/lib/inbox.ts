import { type Inbox, type InboxPr, type PrRef, prKey } from "../../shared/schema.ts";
import type { Gh } from "./gh.ts";
import {
  type GqlActor,
  actor,
  prState,
  reviewDecision,
  reviewState,
  rollupState,
} from "./github.ts";

/*
 * The inbox is one GraphQL request: four searches and one `resource(url:)`
 * lookup per pin. `resource` answers null for a pull request that no longer
 * exists or that the viewer lost access to, where `repository(...)` would
 * fail the whole request, so a stale pin drops out instead.
 */

const OPEN = "is:pr is:open archived:false";

export const INBOX_SEARCHES = {
  requested: `${OPEN} user-review-requested:@me`,
  assignee: `${OPEN} assignee:@me`,
  team: `${OPEN} review-requested:@me -user-review-requested:@me`,
  authored: `${OPEN} author:@me`,
} as const;

const INBOX_PR = `fragment InboxPr on PullRequest {
  number title url state isDraft updatedAt
  repository { name owner { login } }
  author { login avatarUrl }
  headRefName baseRefName additions deletions changedFiles reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  viewerLatestReview { state }
  pendingReviews: reviews(states: [PENDING], first: 1) { totalCount }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
}`;

/** The inbox query for `pinCount` pins: each pin is `$u<i>`, aliased `p<i>`. */
export function inboxQuery(pinCount: number): string {
  const pins = Array.from({ length: pinCount }, (_, i) => i);
  const variables = [
    "$requested: String!",
    "$assignee: String!",
    "$team: String!",
    "$authored: String!",
    ...pins.map((i) => `$u${i}: URI!`),
  ].join(", ");
  const search = (alias: string) =>
    `  ${alias}: search(query: $${alias}, type: ISSUE, first: 50) { nodes { ...InboxPr } }`;
  return [
    `query Inbox(${variables}) {`,
    "  viewer { login }",
    ...Object.keys(INBOX_SEARCHES).map(search),
    ...pins.map((i) => `  p${i}: resource(url: $u${i}) { ...InboxPr }`),
    "}",
    INBOX_PR,
  ].join("\n");
}

export function inboxVariables(pins: PrRef[]): Record<string, string> {
  const variables: Record<string, string> = { ...INBOX_SEARCHES };
  pins.forEach((pin, i) => {
    variables[`u${i}`] = `https://github.com/${pin.owner}/${pin.repo}/pull/${pin.number}`;
  });
  return variables;
}

export type GqlInboxPr = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  repository: { name: string; owner: { login: string } };
  author: GqlActor;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  viewerLatestReview: { state: string } | null;
  pendingReviews: { totalCount: number };
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
};

type Search = { nodes: (GqlInboxPr | Record<string, never>)[] };

export type GqlInbox = {
  viewer: { login: string };
  requested: Search;
  assignee: Search;
  team: Search;
  authored: Search;
} & Record<`p${number}`, GqlInboxPr | Record<string, never> | null>;

export function mapInboxPr(node: GqlInboxPr, viewer: string): InboxPr {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
  return {
    ref: { owner: node.repository.owner.login, repo: node.repository.name, number: node.number },
    title: node.title,
    url: node.url,
    state: prState(node.state),
    isDraft: node.isDraft,
    updatedAt: node.updatedAt,
    author: actor(node.author),
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    reviewDecision: reviewDecision(node.reviewDecision),
    checks: rollupState(rollup?.state),
    viewerReview:
      node.pendingReviews.totalCount > 0
        ? "pending"
        : node.viewerLatestReview
          ? reviewState(node.viewerLatestReview.state)
          : null,
    reviewRequestedFromViewer: node.reviewRequests.nodes.some(
      (request) => request.requestedReviewer?.login?.toLowerCase() === viewer.toLowerCase(),
    ),
  };
}

/** Search hits that are pull requests. Issues answer the fragment with `{}`. */
function pullRequests(nodes: readonly (GqlInboxPr | Record<string, never> | null)[]) {
  return nodes.filter((node): node is GqlInboxPr => node !== null && "number" in node);
}

const newestFirst = (a: InboxPr, b: InboxPr) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Sorts the searches into sections. A pull request appears in one review
 * section at most: requested from the viewer or assigned to them first,
 * then through a team. The viewer's own pull requests are under Authored
 * only, even when they assigned themselves.
 */
export function mapInbox(data: GqlInbox, pinCount: number): Inbox {
  const viewer = data.viewer.login;
  const mine = (pr: InboxPr) => pr.author?.login.toLowerCase() === viewer.toLowerCase();
  const map = (nodes: Search["nodes"]) => pullRequests(nodes).map((n) => mapInboxPr(n, viewer));

  const assigned = new Map<string, InboxPr>();
  for (const pr of [...map(data.requested.nodes), ...map(data.assignee.nodes)]) {
    if (!mine(pr)) assigned.set(prKey(pr.ref), pr);
  }
  const team = map(data.team.nodes).filter((pr) => !mine(pr) && !assigned.has(prKey(pr.ref)));
  const pinned = pullRequests(Array.from({ length: pinCount }, (_, i) => data[`p${i}`] ?? null));

  return {
    viewer,
    assigned: [...assigned.values()].sort(newestFirst),
    team: team.sort(newestFirst),
    authored: map(data.authored.nodes).sort(newestFirst),
    pinned: pinned.map((node) => mapInboxPr(node, viewer)),
  };
}

export async function loadInbox(gh: Gh, pins: PrRef[]): Promise<Inbox> {
  const data = (await gh.graphql(inboxQuery(pins.length), inboxVariables(pins), {
    // A pin in an org that now enforces SAML answers FORBIDDEN: it drops out like a deleted one.
    optionalRoot: (name) => /^p\d+$/.test(name),
  })) as GqlInbox;
  return mapInbox(data, pins.length);
}
