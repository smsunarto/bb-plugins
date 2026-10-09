import { expect, test } from "bun:test";
import { GraphqlFailure, fakeGh, fixture } from "../../../test/fake-gh.ts";
import {
  type GqlPullRequest,
  type GqlThread,
  loadPrHead,
  loadPullRequest,
} from "./pull-request.ts";

const CLI_9000 = { owner: "cli", repo: "cli", number: 9000 };
const WILLIAM = {
  login: "williammartin",
  avatarUrl:
    "https://avatars.githubusercontent.com/u/1611510?u=1208184deacce6d59b31fb28f8464688c577ffdf&v=4",
};
const ANDY = {
  login: "andyfeller",
  avatarUrl:
    "https://avatars.githubusercontent.com/u/2089743?u=9bfb41dc48321cdf872336340b0769283953fe50&v=4",
};

/**
 * The cli/cli#9000 recording, edited the way a test needs. It was recorded
 * before the query asked for comment pages and start sides, so those are
 * filled in as GitHub answers them today: one page, and no start side.
 */
function edited(edit: (pr: GqlPullRequest["repository"]["pullRequest"]) => void = () => {}) {
  const data = fixture<GqlPullRequest>("pull-request-cli-9000.json");
  for (const thread of data.repository.pullRequest.reviewThreads.nodes) {
    thread.startDiffSide = null;
    thread.comments.pageInfo = { hasNextPage: false, endCursor: null };
  }
  edit(data.repository.pullRequest);
  return data;
}

test("reads a recorded merged pull request with its reviews, events, and threads", async () => {
  const { gh, calls } = fakeGh({
    graphql: {
      PullRequest: edited(),
      Stack: fixture("stack-cli-9000.json"),
    },
  });

  const pr = await loadPullRequest(gh, CLI_9000);

  expect(calls.map((call) => (call.kind === "graphql" ? call.variables : null))).toEqual([
    { owner: "cli", name: "cli", number: 9000 },
    // The base is the default branch, so only children are looked for.
    {
      owner: "cli",
      name: "cli",
      head: "andyfeller/flag-level-disableauth",
      base: "trunk",
      children: true,
      parents: false,
    },
  ]);
  expect({
    id: pr.id,
    state: pr.state,
    headRefOid: pr.headRefOid,
    baseRefOid: pr.baseRefOid,
    headRepository: pr.headRepository,
    commitCount: pr.commitCount,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    labels: pr.labels,
    viewer: pr.viewer,
    pendingReview: pr.pendingReview,
    stack: pr.stack,
  }).toEqual({
    id: "PR_kwDODKw3uc5tufty",
    state: "merged",
    headRefOid: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
    baseRefOid: "28c4d3075b5916acdb6974a7e4f5c49d2c274a86",
    headRepository: "cli/cli",
    commitCount: 3,
    reviewDecision: "approved",
    mergeable: "unknown",
    labels: [{ name: "external", color: "2700AF" }],
    // Nobody approves a merged pull request.
    viewer: { login: "sms-yui", isAuthor: false, canApprove: false },
    pendingReview: null,
    stack: { parent: null, children: [] },
  });
  expect(pr.reviewers.map(({ name, state }) => `${name}:${state}`)).toEqual([
    "steiza:approved",
    "williammartin:approved",
  ]);
  expect(pr.timeline.map((item) => (item.kind === "event" ? item.text : item.kind))).toEqual([
    "commit",
    "review",
    "comment",
    "comment",
    "comment",
    "commit",
    "marked this ready for review",
    "requested a review",
    "requested a review",
    "requested a review from williammartin",
    "review",
    "commit",
    "review",
    "merged commit 68dfd87 into trunk",
    "closed this",
  ]);
  expect(pr.timeline[1]).toEqual({
    kind: "review",
    id: "PRR_kwDODKw3uc54m4Eg",
    author: {
      login: "steiza",
      avatarUrl:
        "https://avatars.githubusercontent.com/u/167759?u=abcc2840cccd26a1f83f40fff7314a36552e4f65&v=4",
    },
    state: "approved",
    body: "This looks like a workable alternative to #8995 to me!",
    createdAt: "2024-04-25T19:55:42Z",
    url: "https://github.com/cli/cli/pull/9000#pullrequestreview-2023457056",
    commentCount: 0,
  });
  expect(pr.timeline[5]).toEqual({
    kind: "commit",
    id: "PURC_lADODKw3uc5tufty2gAoOGUzYWZlNTVkZjAzNzQ5MzQzZDM3NzFjODA0MTA2ZGMyYTQ3NmYyYQ",
    oid: "8e3afe55df03749343d3771c804106dc2a476f2a",
    message: "Test cmdutil.IsAuthCheckEnabled cases",
    author: ANDY,
    createdAt: "2024-04-29T14:02:01Z",
  });
  expect(
    pr.threads.map(({ comments: _comments, diffHunk: _diffHunk, ...thread }) => thread),
  ).toEqual([
    {
      id: "PRRT_kwDODKw3uc48Rk4m",
      path: "pkg/cmd/attestation/verify/verify.go",
      line: 130,
      // GitHub reports 130..130: one line.
      startLine: null,
      startSide: null,
      side: "RIGHT",
      originalLine: 130,
      isResolved: true,
      isOutdated: false,
      isFileLevel: false,
    },
    {
      id: "PRRT_kwDODKw3uc48RxjH",
      path: "pkg/cmdutil/auth_check_test.go",
      line: 113,
      startLine: null,
      startSide: null,
      side: "RIGHT",
      originalLine: 113,
      isResolved: false,
      isOutdated: false,
      isFileLevel: false,
    },
  ]);
  expect(pr.threads[1]?.comments).toEqual([
    {
      id: "PRRC_kwDODKw3uc5eXjzv",
      author: WILLIAM,
      body: "Lol not suspicious of coupling at all.",
      createdAt: "2024-04-29T14:59:46Z",
      url: "https://github.com/cli/cli/pull/9000#discussion_r1583234287",
      isDraft: false,
    },
  ]);
  expect(pr.threads[0]?.diffHunk).toStartWith("@@ -127,6 +127,7 @@ func NewVerifyCmd(");
});

test("reads the open pull requests stacked under and on top of a recorded one", async () => {
  const { gh, calls } = fakeGh({
    graphql: {
      PullRequest: fixture("pull-request-cli-14572.json"),
      Stack: fixture("stack-cli-14572.json"),
    },
  });

  const pr = await loadPullRequest(gh, { owner: "cli", repo: "cli", number: 14572 });

  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "Stack",
    variables: {
      owner: "cli",
      name: "cli",
      head: "bagtoad/artifact-skill-docs",
      base: "bagtoad/artifact-edit",
      children: true,
      parents: true,
    },
  });
  expect(pr.stack).toEqual({
    parent: {
      number: 14571,
      title: "`gh issue artifact` stack 8/11: Add `edit`",
      state: "open",
      isDraft: false,
      headRefName: "bagtoad/artifact-edit",
      baseRefName: "bagtoad/artifact-create",
    },
    children: [
      {
        number: 14580,
        title: "`gh issue artifact` stack 10/11: Add `edit --restore-version`",
        state: "open",
        isDraft: false,
        headRefName: "bagtoad/artifact-restore-version",
        baseRefName: "bagtoad/artifact-skill-docs",
      },
    ],
  });
  expect(pr.reviewers).toEqual([
    {
      name: "babakks",
      kind: "user",
      avatarUrl: "https://avatars.githubusercontent.com/u/36728931?v=4",
      state: "requested",
    },
  ]);
  expect(pr.viewer).toEqual({ login: "sms-yui", isAuthor: false, canApprove: true });
});

test("a review requested from the viewer and a force-push read from a recorded open PR", async () => {
  const { gh } = fakeGh({
    graphql: { PullRequest: fixture("pull-request-acme-api-1034.json"), Stack: { repository: {} } },
  });

  const pr = await loadPullRequest(gh, { owner: "acme", repo: "api", number: 1034 });

  expect(pr.reviewers).toEqual([
    {
      name: "sms-yui",
      kind: "user",
      avatarUrl:
        "https://avatars.githubusercontent.com/u/287818108?u=61ef9d5179ffb75cd724908cbfd3170149fb6872&v=4",
      state: "requested",
    },
  ]);
  expect(pr.timeline.map((item) => (item.kind === "event" ? item.text : item.kind))).toEqual([
    "requested a review from sms-yui",
    "comment",
    "commit",
    "force-pushed the branch",
  ]);
  expect(pr.timeline[2]).toMatchObject({
    author: {
      login: "detail-app[bot]",
      avatarUrl: "https://avatars.githubusercontent.com/in/987401?v=4",
    },
  });
  expect(pr.mergeable).toBe("mergeable");
});

function draftThread(id: string, lines: Partial<GqlThread> = {}): GqlThread {
  return {
    id,
    path: "a.ts",
    line: 12,
    startLine: 10,
    startDiffSide: null,
    originalLine: 12,
    diffSide: "LEFT",
    isResolved: false,
    isOutdated: false,
    subjectType: "LINE",
    ...lines,
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: `${id}-c`,
          author: { login: "sms-yui", avatarUrl: null },
          body: "draft",
          createdAt: "2026-10-01T00:00:00Z",
          url: "",
          state: "PENDING",
          diffHunk: "@@ -1 +1 @@",
        },
      ],
    },
  };
}

test("threads past the first hundred are fetched, so a long review keeps its newest drafts", async () => {
  const data = edited((pr) => {
    pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "c100" };
  });
  const { gh, calls } = fakeGh({
    graphql: {
      PullRequest: data,
      ReviewThreads: {
        node: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [draftThread("T101")],
          },
        },
      },
      Stack: { repository: { children: { nodes: [] } } },
    },
  });

  const pr = await loadPullRequest(gh, CLI_9000);

  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "ReviewThreads",
    variables: { id: "PR_kwDODKw3uc5tufty", after: "c100" },
  });
  expect(pr.threads).toHaveLength(3);
  expect(pr.threads[2]).toEqual({
    id: "T101",
    path: "a.ts",
    line: 12,
    startLine: 10,
    startSide: "LEFT",
    side: "LEFT",
    originalLine: 12,
    isResolved: false,
    isOutdated: false,
    isFileLevel: false,
    diffHunk: "@@ -1 +1 @@",
    comments: [
      {
        id: "T101-c",
        author: { login: "sms-yui", avatarUrl: null },
        body: "draft",
        createdAt: "2026-10-01T00:00:00Z",
        url: "",
        isDraft: true,
      },
    ],
  });
});

test("comments past a thread's first hundred are fetched, so a long thread keeps its newest drafts", async () => {
  const data = edited((pr) => {
    const thread = pr.reviewThreads.nodes[1];
    if (thread) thread.comments.pageInfo = { hasNextPage: true, endCursor: "k100" };
  });
  const later = draftThread("T2").comments.nodes[0];
  const { gh, calls } = fakeGh({
    graphql: {
      PullRequest: data,
      ThreadComments: {
        node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [later] } },
      },
      Stack: { repository: { children: { nodes: [] } } },
    },
  });

  const pr = await loadPullRequest(gh, CLI_9000);

  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "ThreadComments",
    variables: { id: "PRRT_kwDODKw3uc48RxjH", after: "k100" },
  });
  expect(pr.threads.map((thread) => thread.comments.map((comment) => comment.id))).toEqual([
    ["PRRC_kwDODKw3uc5eXQNN"],
    ["PRRC_kwDODKw3uc5eXjzv", "T2-c"],
  ]);
  expect(pr.threads[1]?.comments[1]?.isDraft).toBe(true);
});

test("a thread from a base line to a head line keeps its start, even on the same number", async () => {
  const data = edited((pr) => {
    pr.reviewThreads.nodes = [
      draftThread("T1", { startLine: 40, startDiffSide: "LEFT", line: 12, diffSide: "RIGHT" }),
      draftThread("T2", { startLine: 10, startDiffSide: "LEFT", line: 10, diffSide: "RIGHT" }),
      draftThread("T3", { startLine: 10, startDiffSide: "RIGHT", line: 10, diffSide: "RIGHT" }),
    ];
  });
  const { gh } = fakeGh({ graphql: { PullRequest: data, Stack: { repository: {} } } });

  const pr = await loadPullRequest(gh, CLI_9000);

  expect(
    pr.threads.map(({ startLine, startSide, line, side }) => ({
      startLine,
      startSide,
      line,
      side,
    })),
  ).toEqual([
    { startLine: 40, startSide: "LEFT", line: 12, side: "RIGHT" },
    { startLine: 10, startSide: "LEFT", line: 10, side: "RIGHT" },
    // One line on one side.
    { startLine: null, startSide: null, line: 10, side: "RIGHT" },
  ]);
});

test("the viewer's pending review is their drafts, not a timeline entry", async () => {
  const data = edited((pr) => {
    pr.pendingReviews.nodes = [{ id: "PRR_pending", body: "", comments: { totalCount: 2 } }];
    pr.timelineItems.nodes.push({
      __typename: "PullRequestReview",
      id: "PRR_pending",
      author: { login: "sms-yui", avatarUrl: null },
      state: "PENDING",
      body: "",
      createdAt: "2026-10-01T00:00:00Z",
      submittedAt: null,
      url: "",
      comments: { totalCount: 2 },
    });
  });
  const { gh } = fakeGh({ graphql: { PullRequest: data, Stack: { repository: {} } } });

  const pr = await loadPullRequest(gh, CLI_9000);

  expect(pr.pendingReview).toEqual({ id: "PRR_pending", body: "", draftCount: 2 });
  expect(pr.timeline.some((item) => item.id === "PRR_pending")).toBe(false);
});

test("a fork, or a pull request between default branches, is not looked up as a stack", async () => {
  const fork = edited((pr) => {
    pr.isCrossRepository = true;
    pr.headRepository = { nameWithOwner: "someone/cli" };
  });
  const forkGh = fakeGh({ graphql: { PullRequest: fork } });
  expect((await loadPullRequest(forkGh.gh, CLI_9000)).stack).toEqual({
    parent: null,
    children: [],
  });
  expect(forkGh.operations()).toEqual(["PullRequest"]);

  const release = edited((pr) => {
    pr.headRefName = "trunk";
    pr.baseRefName = "trunk";
  });
  const releaseGh = fakeGh({ graphql: { PullRequest: release } });
  await loadPullRequest(releaseGh.gh, CLI_9000);
  expect(releaseGh.operations()).toEqual(["PullRequest"]);
});

test("the author is not their own reviewer, and a re-requested reviewer is listed once", async () => {
  const data = edited((pr) => {
    pr.reviewRequests.nodes = [
      { requestedReviewer: { __typename: "User", login: "steiza", avatarUrl: "s.png" } },
      {
        requestedReviewer: {
          __typename: "Team",
          slug: "cli-maintainers",
          teamAvatarUrl: null,
          organization: { login: "cli" },
        },
      },
    ];
    pr.latestReviews.nodes.push({
      state: "COMMENTED",
      author: { login: "andyfeller", avatarUrl: null },
    });
  });
  const { gh } = fakeGh({ graphql: { PullRequest: data, Stack: { repository: {} } } });

  const pr = await loadPullRequest(gh, CLI_9000);

  expect(pr.reviewers).toEqual([
    { name: "steiza", kind: "user", avatarUrl: "s.png", state: "requested" },
    { name: "cli/cli-maintainers", kind: "team", avatarUrl: null, state: "requested" },
    { name: "williammartin", kind: "user", avatarUrl: WILLIAM.avatarUrl, state: "approved" },
  ]);
});

test("a missing pull request surfaces GitHub's message", async () => {
  const { gh } = fakeGh({
    graphql: {
      PullRequestHead: () => {
        throw new GraphqlFailure(
          "NOT_FOUND",
          "Could not resolve to a PullRequest with the number of 99999.",
        );
      },
    },
  });
  await expect(loadPrHead(gh, { owner: "cli", repo: "cli", number: 99999 })).rejects.toMatchObject({
    code: "not-found",
    message: "Could not resolve to a PullRequest with the number of 99999.",
  });
});
