import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { environmentPathSchema, unpublishedBranchesSchema } from "../../shared/schema.ts";
import { knownCheckoutPaths } from "../lib/checkout-paths.ts";
import { hostClient } from "../lib/target.ts";

/** Read one host or checkout without waiting for unrelated machines. Failures remain visible. */
export const unpublishedBranchesAt = defineQuery({
  input: z.strictObject({ hostId: z.string().min(1), path: environmentPathSchema.optional() }),
  output: unpublishedBranchesSchema,
  async execute(ctx, { hostId, path }) {
    const machine = (await knownCheckoutPaths(ctx.bb)).find(({ host }) => host.id === hostId);
    if (!machine) throw new Error("bb knows no checkout on that machine, or it is offline.");
    const { branches } = await hostClient(ctx.bb).call(
      "unpublishedBranches",
      { paths: machine.paths, ...(path ? { path } : {}) },
      { hostId, timeoutMs: 30_000 },
    );
    return {
      branches: branches.map((branch) =>
        Object.assign(branch, { hostId, machine: machine.host.name }),
      ),
    };
  },
});
