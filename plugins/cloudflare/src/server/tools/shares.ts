import type { Context } from "@bb-kit/core/plugin";
import { defineTool } from "@bb-kit/core/tools";
import type { ToolContext } from "@bb-kit/core/tools";
import { z } from "zod";
import { quickCreateSchema, quickIdSchema } from "../../shared/schema.ts";
import { getQuickShares } from "../lib/quick-shares.ts";
import { overview } from "../rpc/overview.ts";
export const shares = defineTool({
  description:
    "Publish a local HTTP port from a BB host on a temporary public trycloudflare.com URL (a Cloudflare Quick Tunnel). create starts cloudflared on the host and returns the URL; omit hostId to use the thread's own host, or the only online host. Quick shares need no Cloudflare account, are unauthenticated (anyone with the URL reaches the port), and get a new URL on every start. list shows enrolled hosts and current shares; start, stop and remove take a share id. overview returns the connected Cloudflare account inventory (tunnels, Access, DNS). Access-protected shares on your own domain are managed in the Cloudflare panel.",
  parameters: z.discriminatedUnion("action", [
    z.object({ action: z.literal("overview") }).strict(),
    z.object({ action: z.literal("list") }).strict(),
    quickCreateSchema.extend({ action: z.literal("create") }),
    quickIdSchema.extend({ action: z.literal("start") }),
    quickIdSchema.extend({ action: z.literal("stop") }),
    quickIdSchema.extend({ action: z.literal("remove") }),
  ]),
  async execute(ctx: ToolContext<Context>, input) {
    const { action, ...params } = input;
    const quick = getQuickShares(ctx.bb);
    switch (action) {
      case "overview":
        return JSON.stringify(await overview.execute(ctx));
      case "list":
        return JSON.stringify(await quick.list());
      case "create":
        return JSON.stringify(
          await quick.create(quickCreateSchema.parse(params), ctx.tool.threadId ?? undefined),
        );
      case "start":
        return JSON.stringify(await quick.start(quickIdSchema.parse(params).id));
      case "stop":
        return JSON.stringify(await quick.stop(quickIdSchema.parse(params).id));
      case "remove":
        return JSON.stringify(await quick.remove(quickIdSchema.parse(params).id));
    }
  },
});
