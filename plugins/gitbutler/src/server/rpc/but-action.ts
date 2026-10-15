import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  butActionResultSchema,
  butActionSchema,
  checkoutSelectionSchema,
  observedCheckoutSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { assertCheckoutIdle, inCheckout } from "../lib/checkout-ownership.ts";
import { hostClient, repositoryTarget, writeTarget } from "../lib/target.ts";

/** Pushes, pulls, and review creation talk to a remote, so they get longer than a read. */
const ACTION_TIMEOUT_MS = 5 * 60_000;

export const butAction = defineMutation({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      /** The environment of the board the reader acted on. */
      environmentId: z.string().min(1).optional(),
      action: butActionSchema,
      checkout: checkoutSelectionSchema.optional(),
      observed: observedCheckoutSchema.optional(),
    })
    .strict(),
  output: butActionResultSchema,
  async execute(ctx, { threadId, repositoryKey, environmentId, checkout, observed, action }) {
    const target = await writeTarget(ctx.bb, threadId, environmentId, checkout, repositoryKey);
    const run = () =>
      hostClient(ctx.bb).call(
        "butAction",
        {
          ...repositoryTarget(target, repositoryKey),
          ...(observed ? { observed } : {}),
          action,
        },
        { hostId: target.hostId, timeoutMs: ACTION_TIMEOUT_MS },
      );
    if (checkout) {
      const board = await hostClient(ctx.bb).call(
        "workspace",
        repositoryTarget(target, repositoryKey),
        {
          hostId: target.hostId,
        },
      );
      if (board.state !== "ready" || !board.checkoutIdentity) {
        throw new Error(board.reason ?? "This checkout is not available. Refresh and try again.");
      }
      const repository = { hostId: target.hostId, path: board.checkoutIdentity.path };
      return inCheckout(ctx.bb, repository, async () => {
        await assertCheckoutIdle(ctx.bb, threadId, repository);
        await writeTarget(ctx.bb, threadId, target.environmentId);
        return run();
      });
    }
    return run();
  },
});
