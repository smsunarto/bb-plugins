/**
 * A pull request's conversation: comments, reviews, commits and events in
 * GitHub's order, read on demand. Ported from code-review's pull request
 * read (`plugins/code-review/src/server/lib/pull-request.ts`), timeline only.
 */
import type { Repo } from "../core/ids.ts";
import type { TimelineItem } from "../core/items.ts";
import { classifyFailure, GhError, type Exec } from "./github.ts";

const ACTOR = "login avatarUrl";

const TIMELINE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(last: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT]) {
        nodes {
          __typename
          ... on IssueComment { id author { ${ACTOR} } body createdAt url }
          ... on PullRequestReview { id author { ${ACTOR} } state body createdAt submittedAt url comments { totalCount } }
          ... on PullRequestCommit { id commit { oid messageHeadline committedDate author { name avatarUrl user { ${ACTOR} } } } }
          ... on HeadRefForcePushedEvent { id createdAt actor { ${ACTOR} } }
          ... on ReviewRequestedEvent {
            id createdAt actor { ${ACTOR} }
            requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug organization { login } } }
          }
          ... on ReadyForReviewEvent { id createdAt actor { ${ACTOR} } }
          ... on ConvertToDraftEvent { id createdAt actor { ${ACTOR} } }
          ... on MergedEvent { id createdAt actor { ${ACTOR} } mergeRefName mergeCommit: commit { abbreviatedOid } }
          ... on ClosedEvent { id createdAt actor { ${ACTOR} } }
          ... on ReopenedEvent { id createdAt actor { ${ACTOR} } }
        }
      }
    }
  }
}`;

type GqlActor = { login: string; avatarUrl?: string | null } | null;
type Named = { login?: string; slug?: string; organization?: { login: string } } | null;

export type GqlTimelineItem =
  | {
      __typename: "IssueComment";
      id: string;
      author: GqlActor;
      body: string;
      createdAt: string;
      url: string;
    }
  | {
      __typename: "PullRequestReview";
      id: string;
      author: GqlActor;
      state: string;
      body: string;
      createdAt: string;
      submittedAt: string | null;
      url: string;
      comments: { totalCount: number };
    }
  | {
      __typename: "PullRequestCommit";
      id: string;
      commit: {
        oid: string;
        messageHeadline: string;
        committedDate: string;
        author: { name: string | null; avatarUrl: string | null; user: GqlActor } | null;
      };
    }
  | {
      __typename: string;
      id: string;
      createdAt: string;
      actor: GqlActor;
      requestedReviewer?: Named;
      mergeRefName?: string;
      mergeCommit?: { abbreviatedOid: string } | null;
    };

type ReviewState = Extract<TimelineItem, { kind: "review" }>["state"];

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

const actor = (node: GqlActor | undefined) =>
  node ? { login: node.login, avatarUrl: node.avatarUrl ?? null } : null;

function reviewerName(node: Named): string | null {
  if (!node) return null;
  if (node.slug) return node.organization ? `${node.organization.login}/${node.slug}` : node.slug;
  return node.login ?? null;
}

function eventText(item: Extract<GqlTimelineItem, { actor: GqlActor }>): string | null {
  switch (item.__typename) {
    case "HeadRefForcePushedEvent":
      return "force-pushed the branch";
    case "ReviewRequestedEvent": {
      const name = reviewerName(item.requestedReviewer ?? null);
      return name ? `requested a review from ${name}` : "requested a review";
    }
    case "ReadyForReviewEvent":
      return "marked this ready for review";
    case "ConvertToDraftEvent":
      return "converted this to a draft";
    case "MergedEvent":
      return item.mergeCommit && item.mergeRefName
        ? `merged commit ${item.mergeCommit.abbreviatedOid} into ${item.mergeRefName}`
        : "merged this";
    case "ClosedEvent":
      return "closed this";
    case "ReopenedEvent":
      return "reopened this";
    default:
      return null;
  }
}

/** A commit's GitHub user, else the name git recorded. */
function commitAuthor(
  author: { name: string | null; avatarUrl: string | null; user: GqlActor } | null,
) {
  if (author?.user) return actor(author.user);
  return author?.name ? { login: author.name, avatarUrl: author.avatarUrl ?? null } : null;
}

/**
 * Timeline items in GitHub's order. The viewer's pending review is their
 * unsent draft, not something that happened, so it is left out.
 */
export function mapTimeline(items: readonly GqlTimelineItem[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  for (const item of items) {
    if ("body" in item && item.__typename === "IssueComment") {
      const { id, body, createdAt, url } = item;
      timeline.push({ kind: "comment", id, author: actor(item.author), body, createdAt, url });
    } else if ("comments" in item && item.__typename === "PullRequestReview") {
      if (item.state === "PENDING") continue;
      timeline.push({
        kind: "review",
        id: item.id,
        author: actor(item.author),
        state: REVIEW_STATES[item.state] ?? "commented",
        body: item.body,
        createdAt: item.submittedAt ?? item.createdAt,
        url: item.url,
        commentCount: item.comments.totalCount,
      });
    } else if ("commit" in item && item.__typename === "PullRequestCommit") {
      const { commit } = item;
      timeline.push({
        kind: "commit",
        id: item.id,
        oid: commit.oid,
        message: commit.messageHeadline,
        author: commitAuthor(commit.author),
        createdAt: commit.committedDate,
      });
    } else if ("actor" in item) {
      const text = eventText(item);
      if (text === null) continue;
      timeline.push({
        kind: "event",
        id: item.id,
        actor: actor(item.actor),
        text,
        createdAt: item.createdAt,
      });
    }
  }
  return timeline;
}

export async function readTimeline(
  exec: Exec,
  repo: Repo,
  number: number,
  signal?: AbortSignal,
): Promise<TimelineItem[]> {
  const body = JSON.stringify({
    query: TIMELINE,
    variables: { owner: repo.owner, name: repo.name, number },
  });
  const result = await exec(["api", "graphql", "--input", "-"], { stdin: body, signal });
  let parsed:
    | {
        data?: {
          repository?: {
            pullRequest?: { timelineItems?: { nodes?: (GqlTimelineItem | null)[] } } | null;
          } | null;
        };
        errors?: { message?: string }[];
      }
    | undefined;
  try {
    parsed = result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  const error = parsed?.errors?.[0];
  if (error) throw new GhError("failed", error.message ?? "GitHub GraphQL request failed.");
  if (result.code !== 0 || !parsed?.data) throw classifyFailure(result);
  const nodes = parsed.data.repository?.pullRequest?.timelineItems?.nodes ?? [];
  return mapTimeline(nodes.filter((node): node is GqlTimelineItem => node !== null));
}
