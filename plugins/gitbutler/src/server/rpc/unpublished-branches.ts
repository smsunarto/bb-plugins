import { defineQuery } from "@bb-kit/core/rpc";
import { unpublishedBranchesSchema } from "../../shared/schema.ts";
import { knownCheckoutPaths } from "../lib/checkout-paths.ts";
import { hostClient } from "../lib/target.ts";

/** A machine reads one `but status` per workspace it holds, and a laptop can be slow to answer. */
const MACHINE_TIMEOUT_MS = 30_000;

/**
 * Every GitButler branch on a connected machine that has commits but no
 * review on the forge yet, so another plugin (Code Review) can review it
 * before it is published. A machine that is offline or fails to answer is
 * left out.
 */
export const unpublishedBranches = defineQuery({
  output: unpublishedBranchesSchema,
  async execute(ctx) {
    const client = hostClient(ctx.bb);
    const machines = await knownCheckoutPaths(ctx.bb);
    const reads = await Promise.all(
      machines.map(async ({ host, paths }) => {
        try {
          const { branches } = await client.call(
            "unpublishedBranches",
            { paths },
            { hostId: host.id, timeoutMs: MACHINE_TIMEOUT_MS },
          );
          return branches.map((branch) =>
            Object.assign(branch, { hostId: host.id, machine: host.name }),
          );
        } catch (error) {
          ctx.bb.log.warn(`Could not read GitButler branches on ${host.name}: ${String(error)}`);
          return [];
        }
      }),
    );
    return { branches: reads.flat() };
  },
});
