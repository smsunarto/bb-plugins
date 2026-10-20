import { z } from "zod";
import { agentSelection } from "./generation.ts";
import type { CanvasNode } from "./schema.ts";

/** The node kinds whose outputs a review can judge. */
export const reviewable = (kind: CanvasNode["type"]) => kind === "image" || kind === "model-3d";

/** A node's review setting: off, or on with the agent and extra criteria it reviews with. */
export const reviewSettings = z.object({
  enabled: z.boolean(),
  agent: agentSelection.optional(),
  criteria: z.string().max(4000).optional(),
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
