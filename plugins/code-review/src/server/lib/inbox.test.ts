import { expect, test } from "bun:test";
import { fakeGh, fixture } from "../../../test/fake-gh.ts";
import { createGh } from "./gh.ts";
import { type GqlInbox, type GqlInboxPr, inboxQuery, loadInbox, mapInbox } from "./inbox.ts";

const PINS = [
  { owner: "cli", repo: "cli", number: 9000 },
  { owner: "nope-nope-xyz", repo: "none", number: 1 },
  { owner: "cli", repo: "cli", number: 9001 },
];

test("reads a recorded inbox: a review request, two authored PRs, and the one pin that resolves", async () => {
  const { gh, calls } = fakeGh({ graphql: { Inbox: fixture("inbox.json") } });

  const inbox = await loadInbox(gh, PINS);

  expect(calls).toEqual([
    {
      kind: "graphql",
      operation: "Inbox",
      variables: {
        requested: "is:pr is:open archived:false user-review-requested:@me",
        assignee: "is:pr is:open archived:false assignee:@me",
        team: "is:pr is:open archived:false review-requested:@me -user-review-requested:@me",
        authored: "is:pr is:open archived:false author:@me",
        u0: "https://github.com/cli/cli/pull/9000",
        u1: "https://github.com/nope-nope-xyz/none/pull/1",
        u2: "https://github.com/cli/cli/pull/9001",
      },
    },
  ]);
  expect(inbox.viewer).toBe("sms-yui");
  // Requested and assigned at once: listed once.
  expect(inbox.assigned).toEqual([
    {
      ref: { owner: "acme", repo: "api", number: 1034 },
      title: "chore: remove an unused decoder",
      url: "https://github.com/acme/api/pull/1034",
      state: "open",
      isDraft: false,
      updatedAt: "2026-10-02T17:52:05Z",
      author: {
        login: "detail-app",
        avatarUrl: "https://avatars.githubusercontent.com/in/987401?v=4",
      },
      headRefName: "chore/remove-unused-decoder",
      baseRefName: "main",
      additions: 0,
      deletions: 29,
      changedFiles: 1,
      reviewDecision: null,
      checks: "failure",
      viewerReview: null,
      reviewRequestedFromViewer: true,
    },
  ]);
  expect(inbox.team).toEqual([]);
  // Newest first.
  expect(inbox.authored.map((pr) => pr.ref.number)).toEqual([1675, 1677]);
  expect(inbox.pinned).toEqual([
    {
      ref: { owner: "cli", repo: "cli", number: 9000 },
      title: "proof of concept for flag-level disable auth check",
      url: "https://github.com/cli/cli/pull/9000",
      state: "merged",
      isDraft: false,
      updatedAt: "2026-08-13T14:03:02Z",
      author: {
        login: "andyfeller",
        avatarUrl:
          "https://avatars.githubusercontent.com/u/2089743?u=9bfb41dc48321cdf872336340b0769283953fe50&v=4",
      },
      headRefName: "andyfeller/flag-level-disableauth",
      baseRefName: "trunk",
      additions: 123,
      deletions: 2,
      changedFiles: 4,
      reviewDecision: "approved",
      checks: null,
      viewerReview: null,
      reviewRequestedFromViewer: false,
    },
  ]);
});

test("a pin in an org that now enforces SAML drops out, and the rest of the inbox loads", async () => {
  // GitHub nulls the second pin and says why, beside the answer for the rest.
  const gh = createGh(async () => ({
    code: 1,
    stderr: "",
    stdout: JSON.stringify({
      data: fixture("inbox.json"),
      errors: [{ type: "FORBIDDEN", path: ["p1"], message: "Resource protected by SAML." }],
    }),
  }));

  const inbox = await loadInbox(gh, PINS);

  expect(inbox.pinned.map((pr) => pr.ref)).toEqual([{ owner: "cli", repo: "cli", number: 9000 }]);
  expect(inbox.authored).toHaveLength(2);
});

test("asks for each pin by a typed URI variable, never by text in the query", () => {
  const query = inboxQuery(2);
  expect(query).toStartWith(
    "query Inbox($requested: String!, $assignee: String!, $team: String!, $authored: String!, $u0: URI!, $u1: URI!) {",
  );
  expect(query).toContain("  p1: resource(url: $u1) { ...InboxPr }");
  expect(inboxQuery(0)).not.toContain("resource(");
});

function pr(number: number, overrides: Partial<GqlInboxPr> = {}): GqlInboxPr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    updatedAt: `2026-01-0${number}T00:00:00Z`,
    repository: { name: "r", owner: { login: "o" } },
    author: { login: "someone", avatarUrl: null },
    headRefName: `b${number}`,
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: "REVIEW_REQUIRED",
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
    viewerLatestReview: null,
    pendingReviews: { totalCount: 0 },
    reviewRequests: { nodes: [] },
    ...overrides,
  };
}

test("a pull request sits in one review section, and the viewer's own only under Authored", () => {
  const data = {
    viewer: { login: "Me" },
    requested: { nodes: [pr(1)] },
    assignee: { nodes: [pr(2), pr(3, { author: { login: "me", avatarUrl: null } })] },
    team: { nodes: [pr(1), pr(4), {}] },
    authored: { nodes: [pr(3, { author: { login: "me", avatarUrl: null } })] },
  } as unknown as GqlInbox;

  const inbox = mapInbox(data, 0);

  expect(inbox.assigned.map((p) => p.ref.number)).toEqual([2, 1]);
  expect(inbox.team.map((p) => p.ref.number)).toEqual([4]);
  expect(inbox.authored.map((p) => p.ref.number)).toEqual([3]);
});

test("the viewer's review reads pending while they hold unsent drafts", () => {
  const data = {
    viewer: { login: "me" },
    requested: {
      nodes: [
        pr(1, { viewerLatestReview: { state: "APPROVED" }, pendingReviews: { totalCount: 1 } }),
        pr(2, {
          viewerLatestReview: { state: "CHANGES_REQUESTED" },
          reviewRequests: {
            nodes: [{ requestedReviewer: { login: "ME" } }, { requestedReviewer: null }],
          },
        }),
      ],
    },
    assignee: { nodes: [] },
    team: { nodes: [] },
    authored: { nodes: [] },
  } as unknown as GqlInbox;

  const [second, first] = mapInbox(data, 0).assigned;

  expect([first?.viewerReview, first?.reviewRequestedFromViewer]).toEqual(["pending", false]);
  expect([second?.viewerReview, second?.reviewRequestedFromViewer]).toEqual([
    "changes_requested",
    true,
  ]);
  expect(second?.checks).toBe("pending");
});
