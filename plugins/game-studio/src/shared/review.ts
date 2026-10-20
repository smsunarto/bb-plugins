import { z } from "zod";
import { agentSelection } from "./generation.ts";
import type { CanvasNode } from "./schema.ts";

/** The node kinds whose outputs a review can judge. */
export const reviewable = (kind: CanvasNode["type"]) => kind === "image" || kind === "model-3d";

/** The most automatic retries one generation run may lead to. */
export const retryLimit = 5;
/**
 * A node's review setting: off, or on with the agent and extra criteria it reviews with, and how
 * many times a run its review rejects is repeated.
 */
export const reviewSettings = z.object({
  enabled: z.boolean(),
  agent: agentSelection.optional(),
  criteria: z.string().max(4000).optional(),
  retries: z.number().int().min(0).max(retryLimit).optional(),
  /** Which verdicts a retry follows: Fail only (the default), or also Pass with fixes. */
  retryOn: z.enum(["fail", "fixes"]).optional(),
});
export type ReviewSettings = z.output<typeof reviewSettings>;

/** One finished review of some of the node's outputs, oldest first in `data.reviews`. */
export const reviewRecord = z.object({
  /** The outputs it judged, as asset ids. */
  assetIds: z.array(z.string().min(1)).min(1),
  jobId: z.string(),
  text: z.string(),
});
export type ReviewRecord = z.output<typeof reviewRecord>;
/** Reviews kept per node; older ones fall off. */
export const reviewLimit = 40;

export function nodeReviewSettings(node: Pick<CanvasNode, "data">): ReviewSettings | undefined {
  const parsed = reviewSettings.safeParse(node.data.review);
  return parsed.success ? parsed.data : undefined;
}

export function nodeReviews(node: Pick<CanvasNode, "data">): ReviewRecord[] {
  const parsed = z.array(z.unknown()).safeParse(node.data.reviews);
  return (parsed.success ? parsed.data : []).flatMap((raw) => {
    const record = reviewRecord.safeParse(raw);
    return record.success ? [record.data] : [];
  });
}

/** The newest review that judged this output. */
export const outputReview = (node: Pick<CanvasNode, "data">, assetId: string | undefined) =>
  assetId ? nodeReviews(node).findLast((record) => record.assetIds.includes(assetId)) : undefined;

export type Verdict = "pass" | "fixes" | "fail";
/** The verdict a review states on its first line, per instructions/canvas-review.md. */
export function reviewVerdict(text: string): Verdict | undefined {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  if (/\*\*\s*pass with fixes\s*\*\*/i.test(first)) return "fixes";
  if (/\*\*\s*pass\s*\*\*/i.test(first)) return "pass";
  if (/\*\*\s*fail\s*\*\*/i.test(first)) return "fail";
  return undefined;
}

/** The request id of the review that follows a generation run, so retries never review twice. */
export const reviewRequestId = (jobId: string) => `${jobId.slice(0, 92)}-review`;
/** The generation run an automatic review judged; manual reviews have none. */
export const reviewedJobId = (reviewId: string) =>
  reviewId.endsWith("-review") ? reviewId.slice(0, -"-review".length) : undefined;

/** The run a chain of retries began with, and how many retries led to this one. */
export function retryLineage(jobId: string) {
  const match = /^(.+)-retry-(\d+)$/.exec(jobId);
  return match ? { root: match[1]!, attempt: Number(match[2]) } : { root: jobId, attempt: 0 };
}
/** The request id of the retry that follows a run, so a repeated adoption never runs it twice. */
export function retryRequestId(jobId: string) {
  const { root, attempt } = retryLineage(jobId);
  return `${root.slice(0, 80)}-retry-${attempt + 1}`;
}
/** Whether a run with this many retries before it should run again after this verdict. */
export function retryWanted(
  settings: ReviewSettings,
  verdict: Verdict | undefined,
  attempt: number,
) {
  if (!settings.enabled || attempt >= (settings.retries ?? 0)) return false;
  return verdict === "fail" || (verdict === "fixes" && settings.retryOn === "fixes");
}
