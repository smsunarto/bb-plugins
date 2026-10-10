import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { otherMachinesSchema, repositoryKeySchema, type Checkout } from "../../shared/schema.ts";
import { hostClient, resolveTarget } from "../lib/target.ts";

/** A machine reads one `but status` per checkout it holds, and a laptop can be slow to answer. */
const MACHINE_TIMEOUT_MS = 30_000;

/**
 * The thread's repository on every connected machine, branches and all. bb
 * knows where checkouts live, as project sources and environments, but not
 * which repository each one holds: a project's source on one machine can be
 * another repository entirely. So every machine is handed every path bb knows
 * there, and keeps the GitButler workspaces whose origin matches this one.
 * A machine that is offline or fails to answer is left out.
 */
export const otherMachines = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: otherMachinesSchema,
  async execute(ctx, { threadId, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) return { checkouts: [], reason, environmentId: null };
    const { environmentId } = target;
    const client = hostClient(ctx.bb);
    let own;
    try {
      own = await client.call(
        "origin",
        { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
        { hostId: target.hostId },
      );
    } catch (error) {
      // No repository, or its machine is offline. The board says which.
      return {
        checkouts: [],
        reason: error instanceof Error ? error.message : String(error),
        environmentId,
      };
    }
    // Without an origin there is nothing to recognize the repository by elsewhere.
    const origin = own.origin;
    if (origin === null) return { checkouts: [], reason: null, environmentId };

    const [hosts, projects, environments] = await Promise.all([
      ctx.bb.sdk.hosts.list(),
      ctx.bb.sdk.projects.list(),
      ctx.bb.sdk.environments.list({ status: "ready" }),
    ]);
    const paths = new Map<string, Set<string>>();
    const add = (hostId: string, path: string | null) => {
      if (!path) return;
      const known = paths.get(hostId) ?? new Set<string>();
      known.add(path);
      paths.set(hostId, known);
    };
    for (const project of projects) {
      for (const source of project.sources) add(source.hostId, source.path);
    }
    for (const environment of environments) add(environment.hostId, environment.path);

    const reads = await Promise.all(
      hosts.map(async (host): Promise<Checkout[]> => {
        const known = paths.get(host.id);
        if (host.status !== "connected" || !known) return [];
        try {
          const { checkouts } = await client.call(
            "checkouts",
            { paths: [...known], origin },
            { hostId: host.id, timeoutMs: MACHINE_TIMEOUT_MS },
          );
          return checkouts
            .filter((checkout) => !(host.id === target.hostId && checkout.path === own.path))
            .map((checkout) => Object.assign(checkout, { hostId: host.id, machine: host.name }));
        } catch (error) {
          ctx.bb.log.warn(`Could not read GitButler checkouts on ${host.name}: ${String(error)}`);
          return [];
        }
      }),
    );
    return { checkouts: reads.flat(), reason: null, environmentId };
  },
});
