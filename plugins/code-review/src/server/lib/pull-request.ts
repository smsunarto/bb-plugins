import type {
  PrRef,
  PullRequest,
  ReviewThread,
  Reviewer,
  StackPr,
  TimelineItem,
} from "../../shared/schema.ts";
import type { Gh } from "./gh.ts";
import {
  type GqlActor,
  type GqlPageInfo,
  actor,
  prState,
  remainingPages,
  reviewDecision,
  reviewState,
} from "./github.ts";

/*
 * One pull request, read in two requests: the pull request itself, then the
 * open pull requests stacked on and under it, which need its branch names.
 * Review threads, and the comments in each, page past 100, so a long review
 * cannot hide the viewer's newest drafts.
 */

const ACTOR = "login avatarUrl";

const COMMENT = `id author { ${ACTOR} } body createdAt url state diffHunk`;

const COMMENTS = `pageInfo { hasNextPage endCursor } nodes { ${COMMENT} }`;

const THREAD = `id path line startLine startDiffSide originalLine diffSide isResolved isOutdated subjectType
  comments(first: 100) { ${COMMENTS} }`;

export const PULL_REQUEST_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequest(number: $number) {
      id number title body url state isDraft createdAt updatedAt
      author { ${ACTOR} }
      headRefName baseRefName headRefOid baseRefOid isCrossRepository
      headRepository { nameWithOwner }
      additions deletions changedFiles reviewDecision mergeable
      commits { totalCount }
      labels(first: 50) { nodes { name color } }
      reviewRequests(first: 50) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { ${ACTOR} }
            ... on Bot { ${ACTOR} }
            ... on Mannequin { ${ACTOR} }
            ... on Team { slug teamAvatarUrl: avatarUrl organization { login } }
          }
        }
      }
      latestReviews(first: 50) { nodes { state author { ${ACTOR} } } }
      pendingReviews: reviews(states: [PENDING], first: 1) { nodes { id body comments { totalCount } } }
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
      reviewThreads(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD} } }
    }
  }
}`;

export const REVIEW_THREADS_QUERY = `query ReviewThreads($id: ID!, $after: String!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD} } }
    }
  }
}`;

export const THREAD_COMMENTS_QUERY = `query ThreadComments($id: ID!, $after: String!) {
  node(id: $id) {
    ... on PullRequestReviewThread { comments(first: 100, after: $after) { ${COMMENTS} } }
  }
}`;

const STACK_PR = "number title state isDraft headRefName baseRefName isCrossRepository";

export const STACK_QUERY = `query Stack($owner: String!, $name: String!, $head: String!, $base: String!, $children: Boolean!, $parents: Boolean!) {
  repository(owner: $owner, name: $name) {
    children: pullRequests(baseRefName: $head, states: [OPEN], first: 20, orderBy: { field: CREATED_AT, direction: ASC }) @include(if: $children) { nodes { ${STACK_PR} } }
    parents: pullRequests(headRefName: $base, states: [OPEN], first: 5) @include(if: $parents) { nodes { ${STACK_PR} } }
  }
}`;

type Requested =
  | { __typename: "User" | "Bot" | "Mannequin"; login: string; avatarUrl: string | null }
  | {
      __typename: "Team";
      slug: string;
      teamAvatarUrl: string | null;
      organization: { login: string };
    }
  | { __typename: string };

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

type GqlComment = {
  id: string;
  author: GqlActor;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  diffHunk: string;
};

type Comments = { pageInfo: GqlPageInfo; nodes: GqlComment[] };

export type GqlThread = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  /** GitHub often leaves this null, on ranges too, so null reads as `diffSide`. */
  startDiffSide: "LEFT" | "RIGHT" | null;
  originalLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  isResolved: boolean;
  isOutdated: boolean;
  subjectType: string;
  comments: Comments;
};

type Threads = { pageInfo: GqlPageInfo; nodes: GqlThread[] };

export type GqlPullRequest = {
  viewer: { login: string };
  repository: {
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    pullRequest: {
      id: string;
      number: number;
      title: string;
      body: string;
      url: string;
      state: string;
      isDraft: boolean;
      createdAt: string;
      updatedAt: string;
      author: GqlActor;
      headRefName: string;
      baseRefName: string;
      headRefOid: string;
      baseRefOid: string;
      isCrossRepository: boolean;
      headRepository: { nameWithOwner: string } | null;
      additions: number;
      deletions: number;
      changedFiles: number;
      reviewDecision: string | null;
      mergeable: string;
      commits: { totalCount: number };
      labels: { nodes: { name: string; color: string }[] };
      reviewRequests: { nodes: { requestedReviewer: Requested | null }[] };
      latestReviews: { nodes: { state: string; author: GqlActor }[] };
      pendingReviews: { nodes: { id: string; body: string; comments: { totalCount: number } }[] };
      timelineItems: { nodes: GqlTimelineItem[] };
      reviewThreads: Threads;
    };
  };
};

type GqlStackPr = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
};

/** A side is absent when the query skipped it. */
export type GqlStack = {
  repository: { children?: { nodes: GqlStackPr[] }; parents?: { nodes: GqlStackPr[] } };
};

/** `org/slug` for a team, the login for anyone else. */
function reviewerName(node: Named): string | null {
  if (!node) return null;
  if (node.slug) return node.organization ? `${node.organization.login}/${node.slug}` : node.slug;
  return node.login ?? null;
}

/**
 * Outstanding requests first, then everyone else's latest review. Someone
 * asked to review again is listed once, as requested. The author's own
 * replies are reviews to GitHub, but the author is not a reviewer.
 */
export function mapReviewers(pr: GqlPullRequest["repository"]["pullRequest"]): Reviewer[] {
  const reviewers: Reviewer[] = [];
  for (const { requestedReviewer: node } of pr.reviewRequests.nodes) {
    const name = reviewerName(node as Named);
    if (!node || !name) continue;
    if ("teamAvatarUrl" in node) {
      reviewers.push({ name, kind: "team", avatarUrl: node.teamAvatarUrl, state: "requested" });
    } else if ("avatarUrl" in node) {
      reviewers.push({ name, kind: "user", avatarUrl: node.avatarUrl, state: "requested" });
    }
  }
  const listed = new Set(reviewers.map((r) => r.name.toLowerCase()));
  const author = pr.author?.login.toLowerCase();
  for (const review of pr.latestReviews.nodes) {
    const who = review.author;
    if (!who || who.login.toLowerCase() === author || listed.has(who.login.toLowerCase())) continue;
    listed.add(who.login.toLowerCase());
    reviewers.push({
      name: who.login,
      kind: "user",
      avatarUrl: who.avatarUrl ?? null,
      state: reviewState(review.state),
    });
  }
  return reviewers;
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

/**
 * Timeline items in GitHub's order. The viewer's pending review is their
 * unsent draft, not something that happened, so it is left out.
 */
export function mapTimeline(items: GqlTimelineItem[]): TimelineItem[] {
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
        state: reviewState(item.state),
        body: item.body,
        createdAt: item.submittedAt ?? item.createdAt,
        url: item.url,
        commentCount: item.comments.totalCount,
      });
    } else if ("commit" in item && item.__typename === "PullRequestCommit") {
      const { commit } = item;
      const user = commit.author?.user;
      const name = commit.author?.name;
      timeline.push({
        kind: "commit",
        id: item.id,
        oid: commit.oid,
        message: commit.messageHeadline,
        author: user
          ? actor(user)
          : name
            ? { login: name, avatarUrl: commit.author?.avatarUrl ?? null }
            : null,
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

export function mapThread(thread: GqlThread): ReviewThread {
  const fileLevel = thread.subjectType === "FILE";
  const line = fileLevel ? null : thread.line;
  // A range from the base to the head is two lines even when both numbers match.
  const crossSide = (thread.startDiffSide ?? thread.diffSide) !== thread.diffSide;
  const multiLine =
    line !== null && thread.startLine !== null && (crossSide || thread.startLine < line);
  return {
    id: thread.id,
    path: thread.path,
    line,
    startLine: multiLine ? thread.startLine : null,
    startSide: multiLine ? (thread.startDiffSide ?? thread.diffSide) : null,
    side: thread.diffSide,
    originalLine: thread.originalLine,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    isFileLevel: fileLevel,
    diffHunk: thread.comments.nodes[0]?.diffHunk ?? "",
    comments: thread.comments.nodes.map((comment) => ({
      id: comment.id,
      author: actor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
      isDraft: comment.state === "PENDING",
    })),
  };
}

const MERGEABLE = { MERGEABLE: "mergeable", CONFLICTING: "conflicting" } as const;

/** The pull request without its stack, which takes a second request. */
export function mapPullRequest(
  ref: PrRef,
  data: GqlPullRequest,
  threads: GqlThread[],
): Omit<PullRequest, "stack" | "account"> {
  const pr = data.repository.pullRequest;
  const viewer = data.viewer.login;
  const isAuthor = pr.author?.login.toLowerCase() === viewer.toLowerCase();
  const state = prState(pr.state);
  const pending = pr.pendingReviews.nodes[0];
  return {
    ref,
    id: pr.id,
    title: pr.title,
    body: pr.body,
    url: pr.url,
    state,
    isDraft: pr.isDraft,
    author: actor(pr.author),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    baseRefOid: pr.baseRefOid,
    headRepository: pr.headRepository?.nameWithOwner ?? null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commitCount: pr.commits.totalCount,
    reviewDecision: reviewDecision(pr.reviewDecision),
    mergeable: MERGEABLE[pr.mergeable as keyof typeof MERGEABLE] ?? "unknown",
    labels: pr.labels.nodes.map(({ name, color }) => ({ name, color })),
    viewer: { login: viewer, isAuthor, canApprove: !isAuthor && state === "open" },
    reviewers: mapReviewers(pr),
    timeline: mapTimeline(pr.timelineItems.nodes),
    threads: threads.map(mapThread),
    pendingReview: pending
      ? { id: pending.id, body: pending.body, draftCount: pending.comments.totalCount }
      : null,
  };
}

const stackPr = (node: GqlStackPr): StackPr => ({
  number: node.number,
  title: node.title,
  state: prState(node.state),
  isDraft: node.isDraft,
  headRefName: node.headRefName,
  baseRefName: node.baseRefName,
});

/**
 * The open pull request this one is stacked on (its head is this one's
 * base), and the open ones stacked on this (their base is this one's head).
 * The default branch is never part of a stack: everything targets it.
 */
export function mapStack(data: GqlStack, number: number): PullRequest["stack"] {
  const parent = data.repository.parents?.nodes.find((node) => !node.isCrossRepository);
  const children = data.repository.children?.nodes ?? [];
  return {
    parent: parent ? stackPr(parent) : null,
    children: children.flatMap((node) => (node.number === number ? [] : [stackPr(node)])),
  };
}

const NO_STACK: PullRequest["stack"] = { parent: null, children: [] };

export async function loadPullRequest(gh: Gh, ref: PrRef): Promise<Omit<PullRequest, "account">> {
  const data = (await gh.graphql(PULL_REQUEST_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  })) as GqlPullRequest;
  const pr = data.repository.pullRequest;
  const threads = await remainingPages(pr.reviewThreads, async (after) => {
    const page = (await gh.graphql(REVIEW_THREADS_QUERY, { id: pr.id, after })) as {
      node: { reviewThreads: Threads };
    };
    return page.node.reviewThreads;
  });
  await Promise.all(
    threads.map(async (thread) => {
      thread.comments.nodes = await remainingPages(thread.comments, async (after) => {
        const page = (await gh.graphql(THREAD_COMMENTS_QUERY, { id: thread.id, after })) as {
          node: { comments: Comments };
        };
        return page.node.comments;
      });
    }),
  );
  const base = mapPullRequest(ref, data, threads);

  // A fork's branches live in another repository, so nothing here stacks on them.
  const defaultBranch = data.repository.defaultBranchRef?.name ?? null;
  const children = !pr.isCrossRepository && pr.headRefName !== defaultBranch;
  const parents = !pr.isCrossRepository && pr.baseRefName !== defaultBranch;
  if (!children && !parents) return { ...base, stack: NO_STACK };
  const stack = (await gh.graphql(STACK_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    head: pr.headRefName,
    base: pr.baseRefName,
    children,
    parents,
  })) as GqlStack;
  return { ...base, stack: mapStack(stack, pr.number) };
}

export const PR_HEAD_QUERY = `query PullRequestHead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url headRefName baseRefName headRefOid baseRefOid isCrossRepository
    }
  }
}`;

/** What a thread started for a pull request needs to know about it. */
export type PrHead = {
  ref: PrRef;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  /** The head branch is in another repository. */
  isFork: boolean;
};

export async function loadPrHead(gh: Gh, ref: PrRef): Promise<PrHead> {
  const data = (await gh.graphql(PR_HEAD_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  })) as {
    repository: {
      pullRequest: Omit<PrHead, "ref" | "isFork"> & { isCrossRepository: boolean };
    };
  };
  const { isCrossRepository, ...pr } = data.repository.pullRequest;
  return { ref, ...pr, isFork: isCrossRepository };
}
