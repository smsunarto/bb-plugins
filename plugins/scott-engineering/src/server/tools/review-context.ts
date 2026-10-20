import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { contextSchema } from "../../shared/review.ts";
import type { ReviewContext } from "../command/review-start.ts";

export const reviewContext = defineTool({
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
