// A pull-request review submitted in one call: the summary, its verdict, and
// every inline comment land together, the way a person submits a review.
//
// The CLI hands argv strings to `parseReviewRequest`; what comes out is the
// exact body GitHub's create-review endpoint takes.
import { z } from "zod";
import { buildMarker } from "./marker";
import { prioritySchema } from "./types";

/** CLI verdict names mapped to GitHub's review events. */
export const REVIEW_EVENTS = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
} as const;
export type ReviewEventName = keyof typeof REVIEW_EVENTS;

const sideSchema = z.enum(["LEFT", "RIGHT"]);

const inlineCommentSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    body: z.string().trim().min(1),
    side: sideSchema.optional(),
    startLine: z.number().int().positive().optional(),
    startSide: sideSchema.optional(),
    priority: prioritySchema.optional(),
  })
  .strict()
  .refine((comment) => comment.startLine === undefined || comment.startLine < comment.line, {
    message: "startLine must come before line",
  });
export type InlineComment = z.infer<typeof inlineCommentSchema>;

/** The JSON body for `POST /repos/{repo}/pulls/{number}/reviews`. */
export interface ReviewPayload {
  event: (typeof REVIEW_EVENTS)[ReviewEventName];
  body: string;
  commit_id?: string;
  comments: {
    path: string;
    line: number;
    body: string;
    side?: "LEFT" | "RIGHT";
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
  }[];
}

export type ParsedReview = { ok: true; payload: ReviewPayload } | { ok: false; error: string };

function parseComments(raw: string | undefined): InlineComment[] | string {
  if (raw === undefined || raw.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return `--comments is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const parsed = z.array(inlineCommentSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  return `--comments is not an array of {path, line, body} objects${where}: ${issue?.message ?? "invalid"}`;
}

/** The run a review belongs to, which its inline comments' markers name. */
export interface ReviewRun {
  rule: string;
  run: string;
  sha: string;
}

function toGitHubComment(
  comment: InlineComment,
  run: ReviewRun | null,
): ReviewPayload["comments"][number] {
  // The marker is SlopCop's to write, not the agent's: it attributes the
  // comment to its run and carries the finding's priority for other readers.
  // Outside a run there is nothing to attribute, so the body stays as written.
  const marker =
    run === null
      ? ""
      : `\n\n${buildMarker({
          ...run,
          kind: "inline",
          ...(comment.priority === undefined ? {} : { priority: comment.priority }),
        })}`;
  const out: ReviewPayload["comments"][number] = {
    path: comment.path,
    line: comment.line,
    body: `${comment.body}${marker}`,
  };
  if (comment.side !== undefined) out.side = comment.side;
  if (comment.startLine !== undefined) out.start_line = comment.startLine;
  // A range starts on the side it ends on unless told otherwise.
  if (comment.startLine !== undefined) {
    out.start_side = comment.startSide ?? comment.side ?? "RIGHT";
  }
  return out;
}

export function parseReviewRequest(input: {
  event: string | undefined;
  body: string | undefined;
  comments: string | undefined;
  commitId: string | null;
  /** The SlopCop run posting this review, or null outside a review thread. */
  run?: ReviewRun | null;
}): ParsedReview {
  const choices = Object.keys(REVIEW_EVENTS).join(", ");
  if (input.event === undefined) return { ok: false, error: `--event is required: ${choices}` };
  if (!Object.hasOwn(REVIEW_EVENTS, input.event)) {
    return { ok: false, error: `unknown --event '${input.event}'; expected ${choices}` };
  }
  const body = input.body?.trim() ?? "";
  if (body === "") return { ok: false, error: "--body is required: the overall review comment" };
  const comments = parseComments(input.comments);
  if (typeof comments === "string") return { ok: false, error: comments };
  return {
    ok: true,
    payload: {
      event: REVIEW_EVENTS[input.event as ReviewEventName],
      body,
      ...(input.commitId === null ? {} : { commit_id: input.commitId }),
      comments: comments.map((comment) => toGitHubComment(comment, input.run ?? null)),
    },
  };
}
