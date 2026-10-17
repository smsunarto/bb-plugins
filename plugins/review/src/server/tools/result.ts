import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { resultSchema } from "../../shared/schema.ts";
import type { ReviewContext } from "../command/start.ts";
import { blocksPublication } from "../lib/review.ts";

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
        deepImplementationCovered:
          "deepImplementationCovered" in value && value.deepImplementationCovered,
        reviews:
          "current" in value
            ? value.reviews.map(({ reviewer, threadId, status, diffCoverage, report, error }) => ({
                reviewer,
                threadId,
                status,
                findings: report?.findings.length ?? null,
                blocking: report?.findings.filter(blocksPublication).length ?? null,
                diffCoverage: {
                  complete: diffCoverage.complete,
                  consistent: diffCoverage.consistent,
                  totalLength: diffCoverage.totalLength,
                  unreadCount: diffCoverage.unread.length,
                },
                error,
              }))
            : null,
        message: "Read every reviewer's full report with review_context section=report",
        nextOffset: 0,
      });
    return { content: [{ type: "text" as const, text }] };
  },
});
