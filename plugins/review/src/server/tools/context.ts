import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { contextSchema } from "../../shared/schema.ts";
import type { ReviewContext } from "../command/start.ts";

export const context = defineTool({
  parameters: contextSchema,
  async execute(ctx: ToolContext<ReviewContext>, input) {
    const tool = ctx.tool;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await ctx.reviews.context(tool.threadId, input, tool.signal)),
        },
      ],
    };
  },
});
