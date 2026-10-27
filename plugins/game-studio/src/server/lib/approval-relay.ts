import {
  APPROVAL_RENDERER,
  type ApprovalNeeded,
  type GameStudioClient,
  generationApprovalResponse,
} from "@argus-labs/game-studio-api";
import type { BbPluginApi, PluginInteractionCancelReason } from "@get-bb/plugin-sdk";

/*
 * The studio answers a paid agent run with what the person has to approve. This plugin shows
 * that in the thread, as the same form as before, records the answer through the API, and
 * makes the request again. The agent hears a decline as a plain result, so a new turn can ask
 * what to change.
 */

/** How long a run waits for the person before the agent is told nobody answered. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type Declined = {
  declined: true;
  reason: "declined" | PluginInteractionCancelReason;
  detail: string;
};
const declined = (reason: Declined["reason"] = "declined"): Declined => ({
  declined: true,
  reason,
  detail:
    reason === "declined"
      ? "The person declined this generation. Nothing was submitted and nothing was spent. Ask what to change before trying again."
      : reason === "timeout"
        ? "Nobody answered the approval form within ten minutes. Nothing was submitted and nothing was spent. Ask the person whether to try again."
        : `The approval form was closed before anyone answered (${reason}). Nothing was submitted and nothing was spent.`,
});

export const needsApproval = (value: unknown): value is ApprovalNeeded =>
  typeof value === "object" &&
  value !== null &&
  (value as { approvalRequired?: unknown }).approvalRequired === true;

export type RelayContext = {
  bb: Pick<BbPluginApi, "ui">;
  api: GameStudioClient;
  gameId: string;
  threadId: string;
};

/**
 * Runs `attempt`; when the studio asks for approval, asks the person in the thread, records
 * the answer, and attempts once more. A second ask is reported rather than looped.
 */
export async function withApproval<T>(
  ctx: RelayContext,
  attempt: () => Promise<T | ApprovalNeeded>,
): Promise<T | Declined> {
  const first = await attempt();
  if (!needsApproval(first)) return first;
  const { payload } = first;
  const summary = payload.items
    .map(
      (item) =>
        `- ${item.title}: ${item.provider}${item.model ? ` ${item.model}` : ""}${item.count > 1 ? ` ×${item.count}` : ""}`,
    )
    .join("\n");
  const result = await ctx.bb.ui.requestInput({
    threadId: ctx.threadId,
    rendererId: APPROVAL_RENDERER,
    title: `Approve ${payload.items.length === 1 ? "a generation" : `${payload.items.length} generations`} for ${payload.gameName}`,
    payload,
    timeoutMs: APPROVAL_TIMEOUT_MS,
    presentation: {
      label: { pending: "Waiting for generation approval", completed: "Generation approval" },
    },
    describeSubmission: (value) => {
      const answer = generationApprovalResponse.safeParse(value);
      return {
        title:
          answer.success && answer.data.approved ? "Approved generation" : "Declined generation",
        detail: summary,
      };
    },
  });
  if (result.outcome === "cancelled") return declined(result.reason);
  const answer = generationApprovalResponse.safeParse(result.value);
  if (!answer.success || !answer.data.approved) return declined();
  await ctx.api.approvals.approve(ctx.gameId, {
    payload,
    grantGame: answer.data.grantGame === true,
    threadId: ctx.threadId,
  });
  const second = await attempt();
  if (needsApproval(second))
    throw new Error(
      "Game Studio still asks for approval after the person approved. Check the studio's approvals for this game before trying again.",
    );
  return second;
}
