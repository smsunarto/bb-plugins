import { expect, test } from "bun:test";
import type { GitHubPullRequestView } from "../shared/pull-request.ts";
import { refusalOf } from "./pull-requests.ts";

const head = "a".repeat(40);
const shown: GitHubPullRequestView = {
  number: 7,
  title: "PR",
  state: "OPEN",
  url: "https://github.com/acme/app/pull/7",
  isDraft: false,
  autoMerge: false,
  baseRefName: "main",
  headRefName: "scott/a",
  headRefOid: head,
  updatedAt: "2026-11-01T00:00:00Z",
  checks: [],
  reviewDecision: null,
  reviewRequestCount: 0,
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
};
const merge = {
  branch: "scott/a",
  action: { operation: "merge", method: "squash" } as const,
  expectedUrl: shown.url,
  expectedHeadOid: head,
};

test("the pull request the reader saw, unchanged, may be merged", () => {
  expect(refusalOf(shown, merge)).toBeNull();
});

test("a pull request with the same number in another repository is refused", () => {
  const other = { ...shown, url: "https://github.com/acme/fork/pull/7" };
  expect(refusalOf(other, merge)).toContain(
    "now has pull request https://github.com/acme/fork/pull/7",
  );
});

test("a merge after new commits is refused", () => {
  expect(refusalOf({ ...shown, headRefOid: "b".repeat(40) }, merge)).toContain("new commits");
});

test("an action that does not fit the pull request's state is refused", () => {
  const ready = { ...merge, action: { operation: "ready" } as const };
  expect(refusalOf(shown, ready)).toBe("Pull request #7 is not a draft.");
  expect(refusalOf({ ...shown, isDraft: true }, ready)).toBeNull();
  expect(refusalOf({ ...shown, state: "MERGED" }, merge)).toBe(
    "Pull request #7 is not open for merging.",
  );
});
