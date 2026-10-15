import { definePlugin } from "@bb-kit/core/plugin";
import { start } from "./command/start.ts";
import { result } from "./command/result.ts";
import { context } from "./command/context.ts";
import { start as startTool } from "./tools/start.ts";
import { result as resultTool } from "./tools/result.ts";
import { context as contextTool } from "./tools/context.ts";
import { authorInstructions, files, MANUAL_SKILLS } from "./lib/review.ts";
import { ReviewService } from "./lib/service.ts";

export default definePlugin({
  pluginId: "review",
  rpc: {},
  command: { start, result, context },
  services(bb) {
    const settings = bb.settings.define({
      claudeModel: {
        type: "string",
        label: "Claude reviewer model",
        description:
          "Claude seat on Standard and Deep panels; Quick's reviewer for OpenAI authors.",
        default: "claude-opus-5-5[1m]",
      },
      codexModel: {
        type: "string",
        label: "Codex reviewer model",
        description: "Codex seat on Standard and Deep panels; Quick's reviewer for other authors.",
        default: "gpt-6-astra",
      },
    });
    return { reviews: new ReviewService(bb, () => settings.get()) };
  },
  // No tool enabled or agents.skills: bb-kit registers tools, and setup owns the one configure.
  agents: { files, tools: { start: startTool, result: resultTool, context: contextTool } },
  setup(ctx) {
    const { bb } = ctx;
    bb.events.on("turn.failed", (event) => ctx.reviews.reviewerFailed(event));
    bb.events.on("message.queued", ({ entry }) => ctx.reviews.cancelObsoleteRetry(entry));
    bb.background.service("review-fallback", {
      start: (signal) => ctx.reviews.reconcileFailures(signal),
    });
    bb.agents.configure((session) => {
      const reviewer = session.origin.pluginId === bb.pluginId;
      const sideChat = session.origin.pluginId === "side-chat";
      return {
        tools: reviewer
          ? ["review_context"]
          : sideChat
            ? []
            : ["review_start", "review_result", "review_context"],
        skills: reviewer || sideChat ? [] : ["review-workflow", ...MANUAL_SKILLS],
        ...(reviewer || sideChat ? {} : { instructions: authorInstructions() }),
      };
    });
  },
});
