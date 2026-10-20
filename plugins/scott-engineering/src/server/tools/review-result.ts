import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { resultSchema } from "../../shared/review.ts";
import type { ReviewContext } from "../command/review-start.ts";

export const reviewResult = defineTool({
  parameters: resultSchema,
  async execute(ctx: ToolContext<ReviewContext>, input) {
    const tool = ctx.tool;
    const value = await ctx.reviews.result(tool.threadId, input, tool.signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  },
});
