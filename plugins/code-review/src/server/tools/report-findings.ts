import { defineTool } from "@bb-kit/core/tools";
import type { ToolContext } from "@bb-kit/core/tools";
import { z } from "zod";
import { diffSideSchema } from "../../shared/schema.ts";
import { publishActivity } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";

const line = z.number().int().positive();

/**
 * How a Codex review hands its findings to the panel. Only threads the
 * panel started as reviews get it: their bb metadata says which pull request.
 */
export const reportFindings = defineTool({
  presentation: {
    label: { pending: "Reporting review findings", completed: "Reported review findings" },
  },
  parameters: z.strictObject({
    summary: z.string().describe("A short overall assessment of the change."),
    findings: z
      .array(
        z.strictObject({
          priority: z.number().int().min(0).max(3).describe("0 = P0 … 3 = P3."),
          title: z.string().min(1),
          body: z.string(),
          path: z.string().min(1),
          line: line.describe("Last line of the range, numbered on `side`."),
          startLine: line.optional().describe("First line of a multi-line range."),
          side: diffSideSchema.optional().describe("RIGHT (head, default) or LEFT (base)."),
        }),
      )
      .max(50),
  }),
  enabled(_ctx, session) {
    return (
      session.pluginMetadata["kind"] === "review" &&
      typeof session.pluginMetadata["pr"] === "string"
    );
  },
  async execute(ctx: ToolContext<CodeReviewContext>, { summary, findings }) {
    const linked = await ctx.store.linkForThread(ctx.tool.threadId);
    if (!linked || linked.link.kind !== "review") {
      throw new Error("This thread is not a Code Review review, so there is nowhere to report to.");
    }
    await ctx.store.setRun({
      threadId: ctx.tool.threadId,
      headRefOid: linked.link.headRefOid,
      baseRefName: linked.link.baseRefName,
      reportedAt: new Date().toISOString(),
      summary: summary.trim() || null,
      findings: findings.map((finding, i) => {
        const start = finding.startLine ?? finding.line;
        return {
          id: `f${i + 1}`,
          priority: finding.priority,
          title: finding.title,
          body: finding.body,
          path: finding.path,
          line: Math.max(start, finding.line),
          startLine: start === finding.line ? null : Math.min(start, finding.line),
          side: finding.side ?? "RIGHT",
        };
      }),
    });
    publishActivity(ctx.bb, linked.key);
    const count = findings.length === 1 ? "1 finding" : `${findings.length} findings`;
    return `Reported ${count} on ${linked.key}.`;
  },
});
