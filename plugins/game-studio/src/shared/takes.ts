import { z } from "zod";
import type { CanvasNode } from "./schema.ts";

/** One generated output kept on a media node; the node's `assetId` is the pick. */
export const takeSchema = z.object({
  assetId: z.string().min(1),
  /** The generation job that produced it; empty for an output that predates takes. */
  jobId: z.string(),
  star: z.literal(true).optional(),
});
export type Take = z.output<typeof takeSchema>;

/** A node's takes, oldest first. A legacy output without takes becomes its only take. */
export function nodeTakes(node: Pick<CanvasNode, "data">): Take[] {
  const parsed = z.array(z.unknown()).safeParse(node.data.takes);
  const takes = (parsed.success ? parsed.data : []).flatMap((raw) => {
    const take = takeSchema.safeParse(raw);
    return take.success ? [take.data] : [];
  });
  const pick = node.data.assetId;
  if (typeof pick === "string" && pick && !takes.some((take) => take.assetId === pick))
    takes.unshift({ assetId: pick, jobId: "" });
  return takes;
}

/**
 * A batch sends one request per image as `<requestId>-b<index>`. UUID segments are never two
 * characters long, so the suffix cannot collide with a plain request id.
 */
export const batchRequestId = (requestId: string, index: number) => `${requestId}-b${index}`;
/** The run a take belongs to: its batch, or its job when it ran alone. */
export const takeRun = (jobId: string) => jobId.replace(/-b\d$/, "");
