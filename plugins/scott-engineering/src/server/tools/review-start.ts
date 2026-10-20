import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { requestSchema } from "../../shared/review.ts";
import type { ReviewContext } from "../command/review-start.ts";

export const reviewStart = defineTool({
  parameters: requestSchema,
  async execute(ctx: ToolContext<ReviewContext>, input) {
    const tool = ctx.tool;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await ctx.reviews.start(tool.threadId, input, tool.signal)),
        },
      ],
    };
  },
});
