import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { type LocalBranches, branchIdSchema, localBranchSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalBranches, rememberBranch } from "../lib/gitbutler.ts";

const MISSING = "This branch is no longer unpublished, or its machine is offline.";

// Legacy cards share each host's in-flight discovery, even when their ids differ.
const discoveries = new WeakMap<BbPluginApi, Map<string, Promise<LocalBranches>>>();
function discover(ctx: CodeReviewContext, hostId: string): Promise<LocalBranches> {
  let pending = discoveries.get(ctx.bb);
  if (!pending) {
    pending = new Map();
    discoveries.set(ctx.bb, pending);
  }
  const existing = pending.get(hostId);
  if (existing) return existing;
  const read = loadLocalBranches(ctx.bb, undefined, { hostId })
    .then(async (result) => {
      if (result.available)
        await Promise.all(
          result.branches.map((branch) => rememberBranch(ctx.bb, ctx.store, branch)),
        );
      return result;
    })
    .finally(() => pending.delete(hostId));
  pending.set(hostId, read);
  return read;
}

/** A card refreshes only its checkout. Legacy cards discover their location once. */
export const localBranch = defineQuery({
  input: z.strictObject({ id: branchIdSchema, threadId: z.string().min(1).optional() }),
  output: localBranchSchema,
  async execute(ctx: CodeReviewContext, { id, threadId }) {
    const read = async (scope: { hostId: string; path?: string }, signal?: AbortSignal) => {
      const result = scope.path
        ? await loadLocalBranches(ctx.bb, signal, scope)
        : await discover(ctx, scope.hostId);
      if (!result.available) throw new Error(result.reason);
      const branch = result.branches.find((each) => each.id === id);
      if (!branch) throw new Error(MISSING);
      return branch;
    };
    const location = await ctx.store.branchLocation(id);
    if (location) return read(location);

    // An unrelated slow machine must not hold a matching branch's card hostage.
    const hosts = (await ctx.bb.sdk.hosts.list()).filter((host) => host.status === "connected");
    const controller = new AbortController();
    try {
      const candidates = hosts.map((host) => read({ hostId: host.id }, controller.signal));
      // Old cards usually name this thread's checkout. Read it independently of
      // other repositories on the same machine, which may be slow or unavailable.
      if (threadId)
        candidates.push(
          (async () => {
            const thread = await ctx.bb.sdk.threads.get({ threadId, include: "environment" });
            const environment = "environment" in thread ? thread.environment : null;
            if (!environment?.path || environment.status !== "ready") throw new Error(MISSING);
            return read({ hostId: environment.hostId, path: environment.path }, controller.signal);
          })(),
        );
      const branch = await Promise.any(candidates);
      await rememberBranch(ctx.bb, ctx.store, branch);
      return branch;
    } catch (error) {
      if (error instanceof AggregateError)
        throw new Error(
          [
            ...new Set(
              error.errors.map((each) => (each instanceof Error ? each.message : String(each))),
            ),
          ].join("; ") || MISSING,
          { cause: error },
        );
      throw error;
    } finally {
      controller.abort();
    }
  },
});
