import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  butActionResponseSchema,
  butActionSchema,
  checkoutSelectionSchema,
  observedCheckoutSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { boardFor } from "../lib/board.ts";
import { assertCheckoutIdle, inCheckout } from "../lib/checkout-ownership.ts";
import { hostClient, locationOf, repositoryTarget, writeTarget } from "../lib/target.ts";
import type { Location } from "../lib/target.ts";

/** Pushes, pulls, and review creation talk to a remote, so they get longer than a read. */
const ACTION_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs one write and answers with the board it left, so the panel draws it
 * at once instead of reading the workspace again.
 */
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
  output: butActionResponseSchema,
  async execute(ctx, { threadId, repositoryKey, environmentId, checkout, observed, action }) {
    const target = await writeTarget(ctx.bb, threadId, environmentId, checkout, repositoryKey);
    const client = hostClient(ctx.bb);
    const run = async (expected?: Location) => {
      const { result, board } = await client.call(
        "butAction",
        {
          ...repositoryTarget(target, repositoryKey),
          ...(observed ? { observed } : {}),
          ...(expected
            ? { expectedCheckout: { path: expected.path, commonDir: expected.commonDir } }
            : {}),
          action,
        },
        { hostId: target.hostId, timeoutMs: ACTION_TIMEOUT_MS },
      );
      return { result, workspace: board ? boardFor(board, target) : null };
    };
    if (checkout) {
      // An agent working in the checkout owns it. Its path is the one the
      // board was read at, and the host refuses the write if it moved since.
      const location = await locationOf(ctx.bb, target, repositoryKey);
      const repository = { hostId: target.hostId, path: location.path };
      return inCheckout(ctx.bb, repository, async () => {
        await assertCheckoutIdle(ctx.bb, threadId, repository);
        await writeTarget(ctx.bb, threadId, target.environmentId);
        return run(location);
      });
    }
    return run();
  },
});
