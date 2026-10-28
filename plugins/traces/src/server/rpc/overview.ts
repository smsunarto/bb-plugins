import { z } from "zod";
import { idSchema, overviewSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const overviewContract = {
  input: z.object({ threadId: idSchema.optional() }).strict(),
  output: overviewSchema,
};

export async function overview(
  ctx: TracesContext,
  { threadId }: z.output<typeof overviewContract.input>,
): Promise<z.input<typeof overviewContract.output>> {
  const hosts = (await ctx.bb.sdk.hosts.list())
    .filter((host) => host.lifecycle.phase !== "removing" && host.lifecycle.phase !== "destroyed")
    .map((host) => ({
      id: host.id,
      name: host.name,
      online: host.status === "connected",
    }));
  if (!threadId) return { hosts, context: null };
  const thread = await ctx.bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) return { hosts, context: null };
  const [environment, events] = await Promise.all([
    ctx.bb.sdk.environments.get({ environmentId: thread.environmentId }),
    ctx.bb.sdk.threads.events.list({
      threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    }),
  ]);
  // A removed machine keeps its threads as history, but its session files
  // went with it: fall back to a machine that is still listed.
  const hostId = environment.hostId;
  if (!hostId || !hosts.some((host) => host.id === hostId)) return { hosts, context: null };
  const identity = events.find((event) => event.type === "thread/identity");
  return {
    hosts,
    context: {
      hostId,
      provider: thread.providerId === "claude" ? "claude-code" : thread.providerId,
      nativeId: identity?.type === "thread/identity" ? identity.data.providerThreadId : null,
      title: thread.title ?? "Untitled thread",
    },
  };
}
