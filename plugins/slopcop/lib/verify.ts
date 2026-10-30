// Did the review actually land?
//
// The agent's transcript is never the source of truth. In live mode this polls
// GitHub's three comment surfaces and matches on the marker; in shadow mode
// there is nothing to poll, so it asserts the agent produced a well-formed body
// instead. Both paths converge on the same status vocabulary.
import { Effect } from "effect";
import { attributeBody, hasVisibleHeader, parseMarker } from "./marker";
import type { GhClient, GhComment, GhError } from "./gh";
import type { CommentKind, RunComment, RunStatus, TargetKind } from "./types";

/** The outcomes verification can conclude; the other statuses are set before or instead of it. */
export type VerifiedStatus = Extract<
  RunStatus,
  | "commented"
  | "commented_partial"
  | "commented_unmarked"
  | "commented_unattributed"
  | "no_comment"
  | "shadowed"
>;

export interface VerifyResult {
  status: VerifiedStatus;
  detail: string | null;
  comments: RunComment[];
}

function excerpt(body: string, limit = 240): string {
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/🚨\s*(\*\*)?\s*SLOP\s*COP\s*(\*\*)?\s*🚨[^\n]*/i, "")
    .replace(/🚨\s*`?slopcop\/[^`]*`?\s*—?/i, "")
    .trim()
    .replace(/\s+/g, " ");
  return stripped.length > limit ? `${stripped.slice(0, limit - 1)}…` : stripped;
}

function toRunComment(
  comment: GhComment,
  runId: string,
  fallbackKind: CommentKind,
  attribution: "marker" | "header" | "account",
): RunComment {
  const marker = parseMarker(comment.body);
  return {
    runId,
    githubId: comment.id,
    kind: marker?.kind ?? fallbackKind,
    path: comment.path,
    line: comment.line,
    url: comment.url,
    bodyExcerpt: excerpt(comment.body),
    attribution,
  };
}

/**
 * Live verification. Sweeps all three surfaces because GitHub keeps top-level
 * comments, inline review comments, and review bodies in separate endpoints —
 * reading only one would under-count a normal multi-comment review, so one
 * failed read fails the verification.
 */
export const verifyLive = Effect.fnUntraced(function* (options: {
  gh: GhClient;
  repo: string;
  prNumber: number;
  targetKind?: TargetKind;
  runId: string;
  startedAt: number;
  authenticatedLogin: string | null;
}): Effect.fn.Return<VerifyResult, GhError> {
  const {
    gh,
    repo,
    prNumber,
    runId,
    startedAt,
    authenticatedLogin,
    targetKind = "pull_request",
  } = options;

  const [issueComments, reviewComments, reviews] =
    targetKind === "issue"
      ? [yield* gh.listIssueComments(repo, prNumber), [], []]
      : yield* Effect.all(
          [
            gh.listIssueComments(repo, prNumber),
            gh.listReviewComments(repo, prNumber),
            gh.listReviews(repo, prNumber),
          ],
          { concurrency: 3 },
        );

  const sources: { comments: GhComment[]; kind: CommentKind }[] = [
    { comments: issueComments, kind: "summary" },
    { comments: reviewComments, kind: "inline" },
    { comments: reviews, kind: "summary" },
  ];

  const matched: RunComment[] = [];
  const headerOnly: RunComment[] = [];
  const unattributed: RunComment[] = [];

  for (const source of sources) {
    for (const comment of source.comments) {
      // GitHub creates an empty-bodied review object as the envelope for a
      // batch of inline comments. It is not a comment, and counting it as an
      // unattributed one turns a perfectly clean review into a false
      // "commented_partial".
      if (comment.body.trim().length === 0) continue;
      const attribution = attributeBody(comment.body, runId);
      if (attribution === "marker") {
        matched.push(toRunComment(comment, runId, source.kind, "marker"));
        continue;
      }
      // Only bodies this run could plausibly have created are considered:
      // ours by account, and newer than the run started.
      const isRecentOwn =
        comment.createdAt >= startedAt &&
        (authenticatedLogin === null || comment.author === authenticatedLogin);
      if (!isRecentOwn) continue;
      if (attribution === "header" || hasVisibleHeader(comment.body)) {
        headerOnly.push(toRunComment(comment, runId, source.kind, "header"));
      } else {
        unattributed.push(toRunComment(comment, runId, source.kind, "account"));
      }
    }
  }

  if (matched.length > 0 && headerOnly.length + unattributed.length === 0) {
    return {
      status: "commented",
      detail: null,
      comments: matched,
    };
  }
  if (matched.length > 0) {
    return {
      status: "commented_partial",
      detail: `${matched.length} comment(s) carried the marker, ${
        headerOnly.length + unattributed.length
      } did not`,
      comments: [...matched, ...headerOnly, ...unattributed],
    };
  }
  if (headerOnly.length > 0) {
    return {
      status: "commented_unmarked",
      detail:
        "comments carry the SlopCop header but no marker — the agent dropped the required marker",
      comments: headerOnly,
    };
  }
  if (unattributed.length > 0) {
    return {
      status: "commented_unattributed",
      detail: `${unattributed.length} new comment(s) from the authenticated account, but none are provably SlopCop's`,
      comments: unattributed,
    };
  }
  return {
    status: "no_comment",
    detail: `the thread finished without posting anything to the ${
      targetKind === "issue" ? "issue" : "PR"
    }`,
    comments: [],
  };
});

/**
 * Shadow verification. Nothing was posted, so correctness means "the agent
 * produced a body we could have posted" — which is exactly what we want to
 * confirm before promoting a rule to live.
 */
export function verifyShadow(options: {
  runId: string;
  finalMessage: string | null;
}): VerifyResult {
  const body = options.finalMessage ?? "";
  if (body.trim().length === 0) {
    return {
      status: "no_comment",
      detail: "the review thread finished without producing a review",
      comments: [],
    };
  }

  const marker = parseMarker(body);
  const header = hasVisibleHeader(body);
  const comment: RunComment = {
    runId: options.runId,
    githubId: null,
    kind: marker?.kind ?? "summary",
    path: null,
    line: null,
    url: null,
    bodyExcerpt: excerpt(body, 2000),
    attribution: marker !== null ? "marker" : header ? "header" : "account",
  };

  if (marker !== null && marker.run === options.runId) {
    return { status: "shadowed", detail: null, comments: [comment] };
  }
  if (header) {
    return {
      status: "commented_unmarked",
      detail:
        "shadow review has the SlopCop header but no valid marker — it would post unattributably if promoted to live",
      comments: [comment],
    };
  }
  return {
    status: "commented_unattributed",
    detail:
      "shadow review is missing both the header and the marker — the prompt contract was not followed",
    comments: [comment],
  };
}
