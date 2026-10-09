import { describe, expect, test } from "bun:test";
import type {
  AgentActivity,
  Finding,
  LinkedThread,
  PullRequest,
  ReviewThread,
} from "../shared/schema.ts";
import { activeReview, linkedThreadTitle } from "./codex-review.tsx";
import {
  findingDraftBody,
  findingLocation,
  hasDraftFor,
  priorityLabel,
  sortFindings,
} from "./finding.tsx";

function finding(id: string, extra: Partial<Finding> = {}): Finding {
  return {
    id,
    priority: 2,
    title: "Off-by-one in pagination",
    body: "The last page is skipped when `total` is a multiple of `size`.",
    path: "src/page.ts",
    line: 12,
    startLine: null,
    side: "RIGHT",
    ...extra,
  };
}

describe("findings", () => {
  test("priority labels read the way Codex writes them", () => {
    expect([0, 1, 2, 3].map(priorityLabel)).toEqual(["P0", "P1", "P2", "P3"]);
  });

  test("sort most urgent first, then by file and line", () => {
    const sorted = sortFindings([
      finding("a", { priority: 2, path: "b.ts", line: 1 }),
      finding("b", { priority: 0, path: "z.ts", line: 9 }),
      finding("c", { priority: 2, path: "a.ts", line: 30 }),
      finding("d", { priority: 2, path: "a.ts", line: 4 }),
      finding("e", { priority: 1, path: "a.ts", line: 1 }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["b", "e", "d", "c", "a"]);
  });

  test("locations name the line range and the base side", () => {
    expect(findingLocation(finding("a"))).toBe("src/page.ts:12");
    expect(findingLocation(finding("a", { startLine: 10 }))).toBe("src/page.ts:10-12");
    expect(findingLocation(finding("a", { startLine: 12 }))).toBe("src/page.ts:12");
    expect(findingLocation(finding("a", { side: "LEFT" }))).toBe("src/page.ts:12 (base)");
  });

  test("a draft comment leads with the priority and title in bold", () => {
    expect(findingDraftBody(finding("a", { priority: 1 }))).toBe(
      "**[P1] Off-by-one in pagination**\n\nThe last page is skipped when `total` is a multiple of `size`.",
    );
    expect(findingDraftBody(finding("a", { body: "  " }))).toBe(
      "**[P2] Off-by-one in pagination**",
    );
  });

  const comment = (body: string, isDraft: boolean) => ({
    id: "c",
    author: null,
    body,
    createdAt: "2026-10-09T10:00:00Z",
    url: "",
    isDraft,
  });
  const thread = (
    path: string,
    body: string,
    isDraft: boolean,
    at: Partial<Pick<ReviewThread, "line" | "side" | "startLine" | "startSide">> = {},
  ): ReviewThread => ({
    id: "t",
    path,
    line: 12,
    startLine: null,
    startSide: null,
    side: "RIGHT",
    originalLine: 12,
    isResolved: false,
    isOutdated: false,
    isFileLevel: false,
    diffHunk: "",
    comments: [comment(body, isDraft)],
    ...at,
  });
  const pr = (threads: ReviewThread[]) => ({ threads }) as unknown as PullRequest;

  test("a finding already drafted in the pending review is recognised", () => {
    const body = findingDraftBody(finding("a"));

    expect(hasDraftFor(pr([thread("src/page.ts", `${body}\n`, true)]), finding("a"))).toBe(true);
    expect(hasDraftFor(pr([thread("src/page.ts", body, false)]), finding("a"))).toBe(false);
    expect(hasDraftFor(pr([thread("src/other.ts", body, true)]), finding("a"))).toBe(false);
    expect(hasDraftFor(pr([]), finding("a"))).toBe(false);
  });

  test("two identically worded findings at different lines are tracked separately", () => {
    const atFour = finding("a", { line: 4 });
    const atEighty = finding("b", { line: 80 });
    const drafted = pr([thread("src/page.ts", findingDraftBody(atFour), true, { line: 4 })]);

    expect(findingDraftBody(atFour)).toBe(findingDraftBody(atEighty));
    expect(hasDraftFor(drafted, atFour)).toBe(true);
    expect(hasDraftFor(drafted, atEighty)).toBe(false);
  });

  test("a draft counts for a finding only on the finding's side and range", () => {
    const range = finding("a", { startLine: 10 });
    const body = findingDraftBody(range);
    const on = (at: Parameters<typeof thread>[3]) => pr([thread("src/page.ts", body, true, at)]);

    expect(hasDraftFor(on({ startLine: 10, startSide: "RIGHT" }), range)).toBe(true);
    expect(hasDraftFor(on({ startLine: 11, startSide: "RIGHT" }), range)).toBe(false);
    expect(hasDraftFor(on({ startLine: 10, startSide: "LEFT" }), range)).toBe(false);
    expect(hasDraftFor(on({}), range)).toBe(false);
    expect(hasDraftFor(on({ side: "LEFT" }), finding("a"))).toBe(false);
  });
});

describe("linked threads", () => {
  function linked(threadId: string, extra: Partial<LinkedThread> = {}): LinkedThread {
    return {
      threadId,
      kind: "review",
      title: null,
      status: "active",
      createdAt: "2026-10-09T10:00:00Z",
      headRefOid: "head",
      baseRefName: "main",
      ...extra,
    };
  }
  const activity = (threads: LinkedThread[]): AgentActivity => ({ threads, latestReview: null });
  const current = { headRefOid: "head", baseRefName: "main" };

  test("the active review is the busy review thread on the current head and base", () => {
    const threads = [
      linked("fix", { kind: "fix" }),
      linked("old", { headRefOid: "older" }),
      linked("retargeted", { baseRefName: "release" }),
      linked("done", { status: "idle" }),
      linked("now", { status: "starting" }),
    ];
    expect(activeReview(activity(threads), current)?.threadId).toBe("now");
    expect(activeReview(activity(threads.slice(0, 3)), current)).toBeNull();
  });

  test("there is no active review once every review is idle, failed, or gone", () => {
    const threads = [
      linked("a", { status: "idle" }),
      linked("b", { status: "error" }),
      linked("c", { status: "missing" }),
    ];
    expect(activeReview(activity(threads), current)).toBeNull();
    expect(activeReview(undefined, current)).toBeNull();
  });

  test("an untitled thread is named for what it was started to do", () => {
    expect(linkedThreadTitle(linked("a", { title: "Review acme/api#7" }))).toBe(
      "Review acme/api#7",
    );
    expect(linkedThreadTitle(linked("a"))).toBe("Codex review");
    expect(linkedThreadTitle(linked("a", { kind: "fix", title: " " }))).toBe("Fix checks");
  });
});
