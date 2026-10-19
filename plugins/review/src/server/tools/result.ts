import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { resultSchema } from "../../shared/schema.ts";
import type { ReviewContext } from "../command/start.ts";

export const result = defineTool({
  parameters: resultSchema,
  async execute(ctx: ToolContext<ReviewContext>, input) {
    const tool = ctx.tool;
    const value = await ctx.reviews.result(tool.threadId, input, tool.signal);
    let text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > 64000)
      text = JSON.stringify({
        runId: value.runId,
        status: value.status,
        current: "current" in value ? value.current : null,
        reviews:
          "current" in value
            ? value.reviews.map(({ reviewer, threadId, status, fallback, report, error }) => ({
                reviewer,
                threadId,
                status,
                fallback,
                findings: report?.findings.length ?? null,
                error,
              }))
            : null,
        message: "Read every reviewer's full report with review_context section=report",
        nextOffset: 0,
      });
    return { content: [{ type: "text" as const, text }] };
  },
});
