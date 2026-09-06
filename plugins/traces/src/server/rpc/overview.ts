import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { idSchema, overviewSchema } from "../../shared/schema.ts";

export const overview = defineQuery({
  input: z.object({ threadId: idSchema.optional() }).strict(),
  output: overviewSchema,
  async execute(ctx, { threadId }) {
    const hosts = (await ctx.bb.sdk.hosts.list()).map((host) => ({
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
    if (!environment.hostId) return { hosts, context: null };
    const identity = events.find((event) => event.type === "thread/identity");
    return {
      hosts,
      context: {
        hostId: environment.hostId,
        provider: thread.providerId === "claude" ? "claude-code" : thread.providerId,
        nativeId: identity?.type === "thread/identity" ? identity.data.providerThreadId : null,
        title: thread.title ?? "Untitled thread",
      },
    };
  },
});
