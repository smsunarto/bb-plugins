import type { AgentActivity, Checks, Inbox, InboxPr, PullRequest } from "../src/shared/schema.ts";

/*
 * What the server answers the app with, in the shapes `schema.ts` defines.
 * Times are fixed in the past, so relative labels never say "just now".
 */

const ADA = { login: "ada", avatarUrl: null };
const GRACE = { login: "grace", avatarUrl: null };
const VIEWER = { login: "scott", avatarUrl: null };

function inboxPr(overrides: Partial<InboxPr> & Pick<InboxPr, "ref" | "title">): InboxPr {
  return {
    url: `https://github.com/${overrides.ref.owner}/${overrides.ref.repo}/pull/${overrides.ref.number}`,
    state: "open",
    isDraft: false,
    updatedAt: "2026-01-02T10:00:00Z",
    author: ADA,
    headRefName: "feature",
    baseRefName: "main",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    reviewDecision: "review_required",
    checks: "success",
    viewerReview: null,
    reviewRequestedFromViewer: true,
    ...overrides,
  };
}

export const assignedPr = inboxPr({
  ref: { owner: "acme", repo: "api", number: 42 },
  title: "Rate-limit the login endpoint",
  checks: "failure",
});

export const teamPr = inboxPr({
  ref: { owner: "acme", repo: "web", number: 7 },
  title: "Move settings to the new layout",
  author: GRACE,
  reviewRequestedFromViewer: false,
  checks: "pending",
});

export const authoredPr = inboxPr({
  ref: { owner: "acme", repo: "api", number: 51 },
  title: "Drop the legacy token table",
  author: VIEWER,
  isDraft: true,
  reviewDecision: "changes_requested",
  reviewRequestedFromViewer: false,
});

export const inbox: Inbox = {
  viewer: VIEWER.login,
  // Reviewed already, so it no longer waits on the viewer.
  assigned: [
    assignedPr,
    inboxPr({
      ref: { owner: "acme", repo: "api", number: 40 },
      title: "Log slow queries",
      viewerReview: "approved",
    }),
  ],
  team: [teamPr],
  authored: [authoredPr],
  pinned: [],
};

export const pullRequest: PullRequest = {
  ref: assignedPr.ref,
  id: "PR_kwDOA42",
  title: assignedPr.title,
  body: "Adds a **token bucket** in front of `/login`.",
  url: assignedPr.url,
  state: "open",
  isDraft: false,
  author: ADA,
  createdAt: "2026-01-01T09:00:00Z",
  updatedAt: assignedPr.updatedAt,
  headRefName: "ada/rate-limit",
  baseRefName: "main",
  headRefOid: "1111111111111111111111111111111111111111",
  baseRefOid: "2222222222222222222222222222222222222222",
  headRepository: "acme/api",
  additions: 120,
  deletions: 30,
  changedFiles: 4,
  commitCount: 2,
  reviewDecision: "review_required",
  mergeable: "mergeable",
  labels: [{ name: "security", color: "d73a4a" }],
  viewer: { login: VIEWER.login, isAuthor: false, canApprove: true },
  reviewers: [
    { name: VIEWER.login, kind: "user", avatarUrl: null, state: "requested" },
    { name: GRACE.login, kind: "user", avatarUrl: null, state: "approved" },
  ],
  timeline: [
    {
      kind: "commit",
      id: "c1",
      oid: "3333333333333333333333333333333333333333",
      message: "feat(auth): add a token bucket\n\nDetails.",
      author: ADA,
      createdAt: "2026-01-01T09:00:00Z",
    },
    {
      kind: "comment",
      id: "ic1",
      author: GRACE,
      body: "Does this cover the SSO callback too?",
      createdAt: "2026-01-01T11:00:00Z",
      url: "https://github.com/acme/api/pull/42#issuecomment-1",
    },
    {
      kind: "review",
      id: "r1",
      author: GRACE,
      state: "approved",
      body: "Looks good once CI passes.",
      createdAt: "2026-01-01T12:00:00Z",
      url: "https://github.com/acme/api/pull/42#pullrequestreview-1",
      commentCount: 2,
    },
    {
      kind: "event",
      id: "e1",
      actor: ADA,
      text: "force-pushed the branch",
      createdAt: "2026-01-01T13:00:00Z",
    },
  ],
  threads: [],
  pendingReview: { id: "PRR_pending", body: "", draftCount: 2 },
  stack: { parent: null, children: [] },
};

export const checks: Checks = {
  headRefOid: pullRequest.headRefOid,
  state: "failure",
  checks: [
    {
      id: "run:1",
      name: "test",
      workflow: "CI",
      state: "failure",
      description: null,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
      jobId: 1,
    },
    {
      id: "run:2",
      name: "lint",
      workflow: "CI",
      state: "success",
      description: null,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
      jobId: 2,
    },
  ],
};

export const agentActivity: AgentActivity = { threads: [], latestReview: null };
