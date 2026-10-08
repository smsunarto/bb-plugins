import { defineTool } from "@bb-kit/core/tools";
import type { ToolContext } from "@bb-kit/core/tools";
import { z } from "zod";
import { quickCreateSchema, quickIdSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
import { overview } from "../rpc/overview.ts";
export const shares = defineTool({
  presentation: {
    label: { pending: "Managing Cloudflare shares", completed: "Managed Cloudflare shares" },
  },
  parameters: z.discriminatedUnion("action", [
    z.object({ action: z.literal("overview") }).strict(),
    z.object({ action: z.literal("list") }).strict(),
    quickCreateSchema.extend({ action: z.literal("create") }),
    quickIdSchema.extend({ action: z.literal("start") }),
    quickIdSchema.extend({ action: z.literal("stop") }),
    quickIdSchema.extend({ action: z.literal("remove") }),
  ]),
  async execute(ctx: ToolContext<CloudflareContext>, input) {
    const { action, ...params } = input;
    const quick = ctx.quickShares;
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
