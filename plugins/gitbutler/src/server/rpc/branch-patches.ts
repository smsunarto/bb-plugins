import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { commitIdSchema, environmentPathSchema, patchesSchema } from "../../shared/schema.ts";
import { knownCheckoutPaths } from "../lib/checkout-paths.ts";
import { hostClient } from "../lib/target.ts";

/**
 * Every file `head` changes since `base` in the repository at `path` on
 * `hostId`: an unpublished branch's whole diff, for another plugin to review.
 * The repository and commits come from `unpublishedBranches`, and the
 * machine reads only a GitButler workspace among the checkouts bb knows there.
 */
export const branchPatches = defineQuery({
  input: z
    .object({
      hostId: z.string().min(1),
      path: environmentPathSchema,
      base: commitIdSchema,
      head: commitIdSchema,
    })
    .strict(),
  output: patchesSchema,
  async execute(ctx, { hostId, path, base, head }) {
    const machine = (await knownCheckoutPaths(ctx.bb)).find(({ host }) => host.id === hostId);
    if (!machine) throw new Error("bb knows no checkout on that machine, or it is offline.");
    return hostClient(ctx.bb).call(
      "patches",
      { environmentPath: path, source: { kind: "range", base, head, within: machine.paths } },
      { hostId },
    );
  },
});
