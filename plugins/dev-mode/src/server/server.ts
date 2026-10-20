import { definePlugin } from "@bb-kit/core/plugin";
import { z } from "zod";
import { start } from "./command/start.ts";
import { status } from "./command/status.ts";
import { stop } from "./command/stop.ts";
import { ArenaDigests } from "./lib/digests.ts";
import { ArenaService, files } from "./lib/service.ts";
import { rpcContract } from "../shared/rpc.ts";
import { arenaStart } from "./tools/arena-start.ts";
import { arenaStatus } from "./tools/arena-status.ts";
import { arenaStop } from "./tools/arena-stop.ts";
import { arenaContext } from "./tools/arena-context.ts";
import { arenaPrepare } from "./tools/arena-prepare.ts";
import { arenaReport } from "./tools/arena-report.ts";
import { configuration } from "./lib/scope.ts";
import { reviewStart } from "./command/review-start.ts";
import { reviewContext } from "./command/review-context.ts";
import { reviewStart as reviewStartTool } from "./tools/review-start.ts";
import { reviewContext as reviewContextTool } from "./tools/review-context.ts";
import { ReviewService } from "./lib/review-service.ts";
import { principle } from "./command/principle.ts";

export default definePlugin({
  pluginId: "dev-mode",
  rpc: {},
  command: {
    start,
    status,
    stop,
    principle,
    "review-start": reviewStart,
    "review-context": reviewContext,
  },
  agents: {
    files,
    instructions: () => files.read("native-routing"),
    tools: {
      arena_start: arenaStart,
      arena_status: arenaStatus,
      arena_stop: arenaStop,
      arena_context: arenaContext,
      arena_report: arenaReport,
      arena_prepare: arenaPrepare,
      review_start: reviewStartTool,
      review_context: reviewContextTool,
    },
  },
  services(bb) {
    const settings = bb.settings.define({
      reviewClaudeModel: {
        type: "string",
        label: "Claude reviewer model",
        default: "claude-opus-5-5[1m]",
      },
      reviewCodexModel: { type: "string", label: "Codex reviewer model", default: "gpt-6-astra" },
      claudeModel: { type: "string", label: "Claude Arena model", default: "claude-opus-5-5" },
      codexModel: { type: "string", label: "Codex Arena model", default: "gpt-6.1-sol" },
      digestModel: {
        type: "string",
        label: "Model that rewrites results for the card (Codex, fast tier)",
        default: "gpt-6-luna",
      },
    });
    const digests = new ArenaDigests(bb, async () => (await settings.get()).digestModel);
    const arena = new ArenaService(bb, () => settings.get(), digests);
    const reviews = new ReviewService(bb, async () => {
      const values = await settings.get();
      return { claudeModel: values.reviewClaudeModel, codexModel: values.reviewCodexModel };
    });
    return { arena, digests, reviews };
  },
  setup(ctx) {
    const { bb, arena, digests } = ctx;
    // No enabled predicates or agents.skills: bb-kit does not synthesize another configure.
    // In-flight workers still carry pre-rename tool names in their provider context.
    bb.agents.registerTool({
      name: "scott_engineering_arena_context",
      ...files.tool("dev_mode_arena_context"),
      parameters: z.toJSONSchema(arenaContext.parameters),
      execute: (input, tool) =>
        arenaContext.execute({ ...ctx, tool }, arenaContext.parameters.parse(input)),
    });
    bb.agents.registerTool({
      name: "scott_engineering_arena_report",
      ...files.tool("dev_mode_arena_report"),
      parameters: z.toJSONSchema(arenaReport.parameters),
      execute: (input, tool) =>
        arenaReport.execute({ ...ctx, tool }, arenaReport.parameters.parse(input)),
    });
    bb.agents.registerTool({
      name: "scott_engineering_arena_prepare",
      ...files.tool("dev_mode_arena_prepare"),
      parameters: z.toJSONSchema(arenaPrepare.parameters),
      execute: (input, tool) =>
        arenaPrepare.execute({ ...ctx, tool }, arenaPrepare.parameters.parse(input)),
    });
    bb.agents.registerTool({
      name: "scott_engineering_review_context",
      ...files.tool("dev_mode_review_context"),
      parameters: z.toJSONSchema(reviewContextTool.parameters),
      execute: (input, tool) =>
        reviewContextTool.execute({ ...ctx, tool }, reviewContextTool.parameters.parse(input)),
    });
    bb.agents.configure(configuration);
    bb.onDispose(() => arena.dispose());
    bb.rpc.register(rpcContract, {
      get: async ({ runId, threadId }) => ({
        run: await arena.owner(runId, threadId),
        digests: await digests.forRun(runId),
      }),
      stop: async ({ runId, threadId }) => ({ run: await arena.stop(runId, threadId) }),
    });
    for (const event of [
      "thread.created",
      "thread.idle",
      "thread.failed",
      "thread.deleted",
      "thread.archived",
    ] as const) {
      bb.events.on(event, async ({ thread }) => {
        if (thread.originPluginId !== bb.pluginId) return;
        await arena.threadChanged(thread.id);
      });
    }
    bb.background.service("arena-recovery", {
      async start(signal) {
        await arena.recover(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
  },
});
