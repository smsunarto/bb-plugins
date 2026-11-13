import { describe, expect, it } from "vitest";
import { checkSpec } from "../fallback";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import { projectRequests, toMarkdownWithProject } from "./markdown";
import {
  parsePullRequestRefs,
  projectRequestKey,
  type ProjectRequest,
  type ProjectResult,
  type PullRequestInfo,
  type PullRequestRef,
  type PullRequestRow,
} from "./project";
import type { UiNode } from "./types";

function roots(source: string): UiNode[] {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return evaluate(result.program, initialState(result.program)).roots;
}

function markdown(source: string, answer: (request: ProjectRequest) => ProjectResult): string {
  const nodes = roots(source);
  const answers = new Map(
    projectRequests(nodes).map((request) => [projectRequestKey(request), answer(request)] as const),
  );
  return toMarkdownWithProject(nodes, new Map(), answers);
}

const NOW = Date.UTC(2026, 10, 12, 12);

function pr(
  number: number,
  state: PullRequestInfo["state"],
  overrides: Partial<PullRequestInfo> = {},
): PullRequestInfo {
  return {
    number,
    title: `Rampage change ${number}`,
    url: `https://github.com/Argus-Labs/rampage-client/pull/${number}`,
    state,
    baseRef: "main",
    headRef: `feat/${number}`,
    checks: { state: "passing", passed: 5, failed: 0, pending: 0, total: 5 },
    review: { state: "approved", requests: 0 },
    mergeability: state === "draft" ? "draft" : "mergeable",
    attention: state === "merged" ? "merged" : state === "draft" ? "draft" : "ready_to_merge",
    autoMerge: false,
    inMergeQueue: false,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Answers each named ref from `known`; a ref it doesn't know is not found. */
function answerFrom(known: Record<string, PullRequestInfo>) {
  return (request: ProjectRequest): ProjectResult => {
    if (request.kind !== "pullRequests") throw new Error(`unexpected ${request.kind}`);
    const rows: PullRequestRow[] = request.refs.map((ref: PullRequestRef) => {
      const found = known[`${ref.owner}/${ref.repo}#${ref.number}`];
      return {
        ref,
        read: found
          ? { ok: true, pullRequest: found, settling: false }
          : {
              ok: false,
              reason: "not-found",
              message: `${ref.owner}/${ref.repo}#${ref.number} is not a pull request GitHub knows.`,
            },
      };
    });
    return { ok: true, rows, fetchedAt: NOW };
  };
}

describe("PullRequest refs", () => {
  it("reads owner/repo#N and github.com pull request URLs, once each", () => {
    expect(
      parsePullRequestRefs([
        "Argus-Labs/rampage-client#2419",
        "https://github.com/Argus-Labs/rampage-client/pull/2420/files?w=1#diff",
        "argus-labs/rampage-client#2419",
      ]),
    ).toEqual({
      ok: true,
      value: [
        { owner: "Argus-Labs", repo: "rampage-client", number: 2419 },
        { owner: "Argus-Labs", repo: "rampage-client", number: 2420 },
      ],
    });
    expect(parsePullRequestRefs(undefined)).toEqual({ ok: true, value: null });
  });

  it("rejects what names no pull request", () => {
    for (const value of [
      ["#2419"],
      ["https://gitlab.com/o/r/-/merge_requests/1"],
      ["o/r#0"],
      [42],
      "o/r#1",
      [],
    ]) {
      expect(parsePullRequestRefs(value).ok).toBe(false);
    }
    expect(parsePullRequestRefs(Array.from({ length: 51 }, (_, i) => `o/r#${i + 1}`)).ok).toBe(
      false,
    );
  });

  it("collects one read of the first 20 refs, and none for the branch's own PullRequest()", () => {
    const refs = Array.from({ length: 23 }, (_, i) => `"o/r#${i + 1}"`).join(", ");
    const requests = projectRequests(roots(`Card("x", [PullRequest([${refs}]), PullRequest()])`));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ kind: "pullRequests" });
    expect(requests[0]!.kind === "pullRequests" && requests[0]!.refs).toHaveLength(20);
    expect(requests[1]).toEqual({ kind: "pullRequest" });
  });

  it("lists each pull request with its state, checks and review; one that can't be read says why on its own line", () => {
    const text = markdown(
      `PullRequest(["Argus-Labs/rampage-client#2419", "Argus-Labs/rampage-client#2420", "https://github.com/Argus-Labs/rampage-client/pull/2423", "Argus-Labs/rampage-client#9999"])`,
      answerFrom({
        "Argus-Labs/rampage-client#2419": pr(2419, "merged"),
        "Argus-Labs/rampage-client#2420": pr(2420, "open", {
          checks: { state: "pending", passed: 4, failed: 0, pending: 1, total: 5 },
          review: { state: "review_requested", requests: 2 },
          mergeability: "unknown",
          attention: "review_requested",
        }),
        "Argus-Labs/rampage-client#2423": pr(2423, "draft", {
          review: { state: "none", requests: 0 },
        }),
      }),
    );
    expect(text).toBe(`**Pull requests** (4)

- [Argus-Labs/rampage-client#2419 Rampage change 2419](https://github.com/Argus-Labs/rampage-client/pull/2419) · Merged · main ← feat/2419 · Checks passing (5 passed) · Approved
- [Argus-Labs/rampage-client#2420 Rampage change 2420](https://github.com/Argus-Labs/rampage-client/pull/2420) · Open · main ← feat/2420 · Checks running (4 passed · 1 running) · Review requested · Mergeability unknown · needs: Waiting for review
- [Argus-Labs/rampage-client#2423 Rampage change 2423](https://github.com/Argus-Labs/rampage-client/pull/2423) · Draft · main ← feat/2423 · Checks passing (5 passed) · No reviews · Draft · needs: Draft: not ready for review
- Argus-Labs/rampage-client#9999 — _Argus-Labs/rampage-client#9999 is not a pull request GitHub knows._`);
  });

  it("says how many it left out past the first 20", () => {
    const refs = Array.from({ length: 23 }, (_, i) => `"o/r#${i + 1}"`).join(", ");
    const text = markdown(`PullRequest([${refs}])`, answerFrom({}));
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(20);
    expect(text).toContain("**Pull requests** (23)");
    expect(text).toContain("_… and 3 more pull requests_");
  });

  it("without BB, points at the reply instead of the branch's pull request", () => {
    expect(toMarkdown(roots(`PullRequest(["o/r#1", "o/r#2"])`))).toBe(
      "_Pull request status: open the reply in BB to see it._",
    );
  });

  it("check_ui fails a ref that names no pull request, and passes good ones", async () => {
    const load = async () => ({ ok: false as const, error: "no files" });
    const bad = await checkSpec(`PullRequest(["rampage-client#2419"])`, load as never);
    expect(bad.ok).toBe(false);
    expect(bad.report).toContain('"rampage-client#2419" is not "owner/repo#123"');
    const good = await checkSpec(
      `PullRequest(["Argus-Labs/rampage-client#2419", "Argus-Labs/rampage-client#2420"])`,
      load as never,
    );
    expect(good.ok).toBe(true);
  });
});
