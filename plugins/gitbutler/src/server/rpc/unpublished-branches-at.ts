import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import { environmentPathSchema, unpublishedBranchesSchema } from "../../shared/schema.ts";
import { knownCheckoutPaths } from "../lib/checkout-paths.ts";
import { hostClient } from "../lib/target.ts";

export const unpublishedBranchesAtContract = {
  input: z.strictObject({ hostId: z.string().min(1), path: environmentPathSchema.optional() }),
  output: unpublishedBranchesSchema,
};

/** Read one host or checkout without waiting for unrelated machines. Failures remain visible. */
export async function unpublishedBranchesAt(
  ctx: GitButlerContext,
  { hostId, path }: z.output<typeof unpublishedBranchesAtContract.input>,
): Promise<z.input<typeof unpublishedBranchesAtContract.output>> {
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
}
