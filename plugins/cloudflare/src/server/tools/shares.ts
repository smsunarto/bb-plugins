import type { Context } from "@bb-kit/core/plugin";
import { defineTool } from "@bb-kit/core/tools";
import { z } from "zod";
import { createSchema, updateSchema, shareInputSchema } from "../../shared/schema.ts";
import { overview } from "../rpc/overview.ts";
import { create } from "../rpc/create.ts";
import { update } from "../rpc/update.ts";
import { start } from "../rpc/start.ts";
import { stop } from "../rpc/stop.ts";
import { remove } from "../rpc/remove.ts";
export const shares = defineTool({
  description:
    "Inspect Cloudflare inventory and manage plugin-owned protected development shares. Existing tunnels and Access resources are read-only. Use overview for hosts, zones, IdPs and current revisions. Create requires a stable UUID reused on retries. Secrets are configured only in plugin settings.",
  parameters: z.discriminatedUnion("action", [
    z.object({ action: z.literal("overview") }).strict(),
    createSchema.extend({ action: z.literal("create") }),
    updateSchema.extend({ action: z.literal("update") }),
    shareInputSchema.extend({ action: z.literal("start") }),
    shareInputSchema.extend({ action: z.literal("stop") }),
    shareInputSchema.extend({ action: z.literal("remove") }),
  ]),
  async execute(ctx: Context, input) {
    const { action, ...params } = input;
    switch (action) {
      case "overview":
        return JSON.stringify(await overview.execute(ctx));
      case "create":
        return JSON.stringify(await create.execute(ctx, createSchema.parse(params)));
      case "update":
        return JSON.stringify(await update.execute(ctx, updateSchema.parse(params)));
      case "start":
        return JSON.stringify(await start.execute(ctx, shareInputSchema.parse(params)));
      case "stop":
        return JSON.stringify(await stop.execute(ctx, shareInputSchema.parse(params)));
      case "remove":
        return JSON.stringify(await remove.execute(ctx, shareInputSchema.parse(params)));
    }
  },
});
