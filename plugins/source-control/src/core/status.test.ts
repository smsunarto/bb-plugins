import { describe, expect, test } from "vitest";
import type { Branch, PullRequest } from "./change.ts";
import {
  attentionChips,
  primaryAction,
  shipPath,
  sortKey,
  statusLine,
  type ChangeSummary,
} from "./status.ts";

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: "scott/forge-host",
    head: "c0ffee",
    remote: { ref: "origin/scott/forge-host", name: "scott/forge-host" },
    status: "pushed",
    push: "none",
    ahead: 0,
    behind: 0,
    newUpstream: 0,
    reviewId: null,
    commits: [{ id: "c0ffee", subject: "Route gh", createdAt: null, conflicted: false }],
    moreCommits: 2,
    upstreamCommits: [],
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 482,
    url: "https://github.com/smsunarto/bb-plugins/pull/482",
    title: "Route gh through the checkout host",
    state: "open",
    isDraft: true,
    headRefOid: "c0ffee",
    baseRef: "main",
    reviewDecision: "review-required",
    approvals: 0,
    checks: { passed: 9, failed: 0, pending: 2 },
    ...overrides,
  };
}

function summary(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    key: null,
    branch: branch(),
    onGitHub: true,
    uncommitted: 3,
    conflicted: false,
    pullRequest: pr(),
    findings: 0,
    ...overrides,
  };
}

const settled = { passed: 9, failed: 0, pending: 0 };
const approved = pr({ isDraft: false, reviewDecision: "approved", approvals: 1, checks: settled });

/** Board B's change: a draft with 2 checks running, 3 files uncommitted. */
const BOARD_B = summary();
const LOCAL = summary({
  branch: branch({ status: "unpushed", remote: null }),
  pullRequest: null,
  uncommitted: 0,
});
const NOT_COMMITTED = summary({
  branch: branch({ commits: [], moreCommits: 0, status: "empty", remote: null }),
  pullRequest: null,
});
const FAILING = summary({
  pullRequest: pr({ isDraft: false, checks: { passed: 7, failed: 2, pending: 0 } }),
});
const READY = summary({ pullRequest: approved, uncommitted: 0 });
const MERGED = summary({ pullRequest: pr({ state: "merged", isDraft: false, approvals: 1 }) });
const CHANGES = summary({
  pullRequest: pr({ isDraft: false, reviewDecision: "changes-requested", checks: settled }),
});
const CONFLICTED = summary({ conflicted: true });
const FINDINGS = summary({ findings: 4 });
const PUSHED_NO_PR = summary({ pullRequest: null, uncommitted: 0 });
const REVIEW = summary({ pullRequest: pr({ isDraft: false, checks: settled }) });

describe("ship path", () => {
  const states = (s: ChangeSummary) => shipPath(s).map((step) => `${step.label}:${step.state}`);

  test.each([
    [
      "board B: a draft whose checks run",
      BOARD_B,
      [
        "Committed:done",
        "Pushed:done",
        "Draft, waiting on you:current",
        "Checks:running",
        "Approval:todo",
        "Merged:todo",
      ],
    ],
    [
      "local commits, never pushed",
      LOCAL,
      [
        "Committed:done",
        "Pushed:current",
        "Pull request:todo",
        "Checks:todo",
        "Approval:todo",
        "Merged:todo",
      ],
    ],
    [
      "only uncommitted work",
      NOT_COMMITTED,
      [
        "Committed:current",
        "Pushed:todo",
        "Pull request:todo",
        "Checks:todo",
        "Approval:todo",
        "Merged:todo",
      ],
    ],
    [
      "failing checks",
      FAILING,
      [
        "Committed:done",
        "Pushed:done",
        "Ready for review:done",
        "Checks:failed",
        "Approval:todo",
        "Merged:todo",
      ],
    ],
    [
      "approved and green",
      READY,
      [
        "Committed:done",
        "Pushed:done",
        "Ready for review:done",
        "Checks:done",
        "Approved:done",
        "Merged:todo",
      ],
    ],
    [
      "changes requested",
      CHANGES,
      [
        "Committed:done",
        "Pushed:done",
        "Ready for review:done",
        "Checks:done",
        "Changes requested:failed",
        "Merged:todo",
      ],
    ],
    [
      "merged",
      MERGED,
      [
        "Committed:done",
        "Pushed:done",
        "Opened:done",
        "Checks:running",
        "Approved:done",
        "Merged:done",
      ],
    ],
  ])("%s", (_name, input, expected) => {
    expect(states(input)).toEqual(expected);
  });

  test("the checks step counts running then passed, as board A draws it", () => {
    expect(shipPath(BOARD_B)[3]!.detail).toEqual([
      { text: "2 running", tone: "warning" },
      { text: "· 9 passed", tone: "muted" },
    ]);
  });
});

describe("attention chips", () => {
  test.each([
    ["board B", BOARD_B, ["2 Running"]],
    ["findings come first, count first", FINDINGS, ["4 Findings", "2 Running"]],
    ["failing checks", FAILING, ["2 Failed"]],
    ["approved and green", READY, ["Ready to merge", "Passed"]],
    ["changes requested", CHANGES, ["Changes requested", "Passed"]],
    ["conflicted", CONFLICTED, ["Conflicted", "2 Running"]],
    ["local", LOCAL, ["Local"]],
    ["merged", MERGED, ["Merged"]],
    ["pushed, no pull request", PUSHED_NO_PR, []],
  ])("%s", (_name, input, expected) => {
    expect(attentionChips(input).map((chip) => chip.label)).toEqual(expected);
  });

  test("tones follow the boards: running warns, failed errs, passed succeeds", () => {
    expect(attentionChips(FAILING)[0]).toMatchObject({ tone: "error", icon: "cross" });
    expect(attentionChips(BOARD_B)[0]).toMatchObject({ tone: "warning", icon: "dot" });
    expect(attentionChips(READY)[1]).toMatchObject({ tone: "success", icon: "check" });
  });
});

describe("phone status line", () => {
  test.each([
    ["board D: a draft with findings", FINDINGS, "Draft · 4 findings to settle"],
    ["a draft whose checks run", BOARD_B, "Draft · 2 checks running"],
    ["local", LOCAL, "Local, not pushed"],
    ["only uncommitted work", NOT_COMMITTED, "3 uncommitted"],
    ["failing checks", FAILING, "2 checks failed"],
    [
      "one failing check",
      summary({ pullRequest: pr({ checks: { passed: 1, failed: 1, pending: 0 } }) }),
      "1 check failed",
    ],
    ["approved and green", READY, "Ready to merge"],
    ["changes requested", CHANGES, "Changes requested"],
    ["waiting on review", REVIEW, "Review requested"],
    ["pushed, no pull request", PUSHED_NO_PR, "Pushed, no pull request"],
    ["pushed, GitHub not read yet", summary({ pullRequest: undefined, uncommitted: 0 }), "Pushed"],
    ["merged", MERGED, "Merged"],
    ["conflicted", CONFLICTED, "Conflicted"],
  ])("%s", (_name, input, expected) => {
    expect(statusLine(input)).toBe(expected);
  });
});

describe("primary action", () => {
  test.each([
    ["board B: a draft", BOARD_B, "markReady"],
    ["unpushed commits come first", summary({ branch: branch({ status: "ahead" }) }), "push"],
    ["local", LOCAL, "push"],
    ["approved and green", READY, "merge"],
    ["waiting on review", REVIEW, null],
    ["merged", MERGED, null],
    ["conflicted", CONFLICTED, null],
    ["no GitHub remote", summary({ ...LOCAL, onGitHub: false }), null],
  ])("%s", (_name, input, expected) => {
    expect(primaryAction(input)?.kind ?? null).toBe(expected);
  });
});

describe("sort key", () => {
  test("what needs its owner sorts first, what is done last", () => {
    const ordered = [
      CONFLICTED,
      FAILING,
      CHANGES,
      BOARD_B,
      LOCAL,
      READY,
      PUSHED_NO_PR,
      REVIEW,
      MERGED,
    ];
    expect(ordered.map(sortKey)).toEqual([0, 0, 0, 1, 1, 2, 4, 5, 9]);
    expect(sortKey(summary({ pullRequest: pr({ isDraft: false }) }))).toBe(3);
  });
});
