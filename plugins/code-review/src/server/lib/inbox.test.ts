import { expect, test } from "bun:test";
import { GhFailure, fakeGh, fixture } from "../../../test/fake-gh.ts";
import { createGh } from "./gh.ts";
import {
  type GqlInbox,
  type GqlInboxPr,
  inboxQuery,
  loadInbox,
  loadInboxes,
  mapInbox,
} from "./inbox.ts";

const PINS = [
  { owner: "cli", repo: "cli", number: 9000 },
  { owner: "nope-nope-xyz", repo: "none", number: 1 },
  { owner: "cli", repo: "cli", number: 9001 },
];

test("reads a recorded inbox: a review request, two authored PRs, and the one pin that resolves", async () => {
  const { gh, calls } = fakeGh({ graphql: { Inbox: fixture("inbox.json") } });

  const inbox = await loadInbox(gh, PINS, "sms-yui");

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
  // Requested and assigned at once: listed once.
  expect(inbox.assigned).toEqual([
    {
      ref: { owner: "acme", repo: "api", number: 1034 },
      account: "sms-yui",
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
      account: "sms-yui",
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

  const inbox = await loadInbox(gh, PINS, "sms-yui");

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

  const inbox = mapInbox(data, 0, "Me");

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

  const [second, first] = mapInbox(data, 0, "me").assigned;

  expect([first?.viewerReview, first?.reviewRequestedFromViewer]).toEqual(["pending", false]);
  expect([second?.viewerReview, second?.reviewRequestedFromViewer]).toEqual([
    "changes_requested",
    true,
  ]);
  expect(second?.checks).toBe("pending");
});

/** An inbox answer for one account: `sections` names the searches each pull request comes back from. */
function answer(
  viewer: string,
  sections: Partial<Record<keyof GqlInbox, GqlInboxPr[]>>,
  pins = {},
) {
  return {
    viewer: { login: viewer },
    requested: { nodes: sections.requested ?? [] },
    assignee: { nodes: sections.assignee ?? [] },
    team: { nodes: sections.team ?? [] },
    authored: { nodes: sections.authored ?? [] },
    ...pins,
  };
}

test("merges every signed-in account's inbox, each pull request opening as the account it waits on", async () => {
  const shared = pr(1);
  const { github, calls } = fakeGh({
    accounts: ["work", "home"],
    graphql: {
      Inbox: (_variables, account) =>
        account === "work"
          ? answer("work", { requested: [shared], team: [pr(2)], authored: [pr(5)] })
          : answer("home", { team: [shared, pr(3)], requested: [pr(4)] }),
    },
  });

  const inbox = await loadInboxes(github, []);

  expect(calls.map((call) => call.account)).toEqual(["work", "home"]);
  expect(inbox.accounts).toEqual(["work", "home"]);
  expect(inbox.unavailable).toEqual([]);
  expect(inbox.assigned.map((p) => [p.ref.number, p.account])).toEqual([
    [4, "home"],
    [1, "work"],
  ]);
  // #1 waits on work directly and on home's team: each account keeps its own entry.
  expect(inbox.team.map((p) => [p.ref.number, p.account])).toEqual([
    [3, "home"],
    [2, "work"],
    [1, "home"],
  ]);
  expect(inbox.authored.map((p) => [p.ref.number, p.account])).toEqual([[5, "work"]]);
});

test("a pull request waiting on two accounts stays in each account's own queue", async () => {
  const shared = pr(1);
  const { github } = fakeGh({
    accounts: ["work", "home"],
    graphql: {
      Inbox: (_variables, account) => answer(account, { requested: [shared], team: [shared] }),
    },
  });

  const inbox = await loadInboxes(github, []);

  expect(inbox.assigned.map((p) => [p.ref.number, p.account])).toEqual([
    [1, "work"],
    [1, "home"],
  ]);
  // Requested of each account directly, so neither repeats it under My team.
  expect(inbox.team).toEqual([]);
});

test("reads each pin as the account that pinned it, in pin order, and an old pin as the active account", async () => {
  const pinned = (number: number) => ({ owner: "o", repo: "r", number });
  const { github, calls } = fakeGh({
    accounts: ["work", "home"],
    graphql: {
      Inbox: (variables, account) =>
        answer(
          account,
          {},
          Object.fromEntries(
            Object.entries(variables)
              .filter(([name]) => /^u\d+$/.test(name))
              .map(([name, url]) => [
                `p${name.slice(1)}`,
                pr(Number(String(url).split("/").pop())),
              ]),
          ),
        ),
    },
  });

  const inbox = await loadInboxes(github, [
    { ...pinned(3), account: "home" },
    pinned(1),
    { ...pinned(2), account: "WORK" },
    { ...pinned(4), account: "signed-out" },
  ]);

  expect(calls.map((call) => [call.account, call.kind === "graphql" && call.variables])).toEqual([
    [
      "work",
      expect.objectContaining({
        u0: "https://github.com/o/r/pull/1",
        u1: "https://github.com/o/r/pull/2",
      }),
    ],
    ["home", expect.objectContaining({ u0: "https://github.com/o/r/pull/3" })],
  ]);
  expect(inbox.pinned.map((p) => [p.ref.number, p.account])).toEqual([
    [3, "home"],
    [1, "work"],
    [2, "work"],
  ]);
});

test("an account that fails is named, and the others still load", async () => {
  const { github } = fakeGh({
    accounts: ["work", "home"],
    graphql: {
      Inbox: (_variables, account) => {
        if (account === "home") throw new GhFailure("gh: HTTP 401: Bad credentials");
        return answer("work", { requested: [pr(1)] });
      },
    },
  });

  const inbox = await loadInboxes(github, []);

  expect(inbox.assigned.map((p) => p.ref.number)).toEqual([1]);
  expect(inbox.unavailable).toEqual([
    { account: "home", message: "GitHub CLI is not signed in. Run `gh auth login`." },
  ]);
});

test("when every account fails, the inbox fails", async () => {
  const { github } = fakeGh({
    graphql: {
      Inbox: () => {
        throw new GhFailure("gh: HTTP 502");
      },
    },
  });

  await expect(loadInboxes(github, [])).rejects.toThrow("HTTP 502");
});
