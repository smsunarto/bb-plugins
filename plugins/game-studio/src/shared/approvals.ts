import { z } from "zod";
import { generationId } from "./generation.ts";

/*
 * A paid generation an agent starts waits for the person once per run. The form lists what
 * the run will make; approving it fixes a budget per request lineage (a batch, plus the
 * retries its review may call for), which the server spends as it dispatches. Runs from the
 * canvas UI never ask: the person clicked.
 */

/** The renderer id the app registers for the approval form. */
export const APPROVAL_RENDERER = "generation-approval";

export const generationApprovalItem = z.strictObject({
  requestId: generationId,
  nodeId: z.string().optional(),
  title: z.string(),
  kind: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  /** Outputs this request makes at once. */
  count: z.number().int().min(1),
  /** Automatic retries its review may add. */
  retries: z.number().int().min(0),
});
export type GenerationApprovalItem = z.output<typeof generationApprovalItem>;

export const generationApprovalPayload = z.strictObject({
  gameId: z.string(),
  gameName: z.string(),
  boardId: z.string().optional(),
  items: z.array(generationApprovalItem).min(1),
});
export type GenerationApprovalPayload = z.output<typeof generationApprovalPayload>;

export const generationApprovalResponse = z.strictObject({
  approved: z.boolean(),
  /** Approve this game's later agent runs too, until bb restarts or the person turns it off. */
  grantGame: z.boolean().optional(),
});
export type GenerationApprovalResponse = z.output<typeof generationApprovalResponse>;

/** Whether a request costs money outside BB: everything but a BB-model run. */
export const paidProvider = (provider: string) => provider !== "bb";
/** Generations an approval covers for one item: its batch and the retries it may lead to. */
export const itemBudget = (item: Pick<GenerationApprovalItem, "count" | "retries">) =>
  item.count * (1 + item.retries);
