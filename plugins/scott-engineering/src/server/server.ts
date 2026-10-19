import { definePlugin } from "@bb-kit/core/plugin";
import { start } from "./command/start.ts";
import { status } from "./command/status.ts";
import { stop } from "./command/stop.ts";
import { ArenaService, files } from "./lib/service.ts";
import { rpcContract } from "../shared/rpc.ts";
import { arenaStart } from "./tools/arena-start.ts";
import { arenaStatus } from "./tools/arena-status.ts";
import { arenaStop } from "./tools/arena-stop.ts";
import { arenaContext } from "./tools/arena-context.ts";
import { arenaPrepare } from "./tools/arena-prepare.ts";
import { arenaReport } from "./tools/arena-report.ts";
import { skills } from "./lib/scope.ts";

export default definePlugin({
  pluginId: "scott-engineering",
  rpc: {},
  command: { start, status, stop },
  agents: {
    files,
    instructions: () => files.read("native-routing"),
    skills,
    tools: {
      arena_start: arenaStart,
      arena_status: arenaStatus,
      arena_stop: arenaStop,
      arena_context: arenaContext,
      arena_report: arenaReport,
      arena_prepare: arenaPrepare,
    },
  },
  services(bb) {
    const settings = bb.settings.define({
      claudeModel: { type: "string", label: "Claude Arena model", default: "claude-opus-5-5" },
      codexModel: { type: "string", label: "Codex Arena model", default: "gpt-6.1-sol" },
    });
    return { arena: new ArenaService(bb, () => settings.get()) };
  },
  setup({ bb, arena }) {
    bb.onDispose(() => arena.dispose());
    bb.rpc.register(rpcContract, {
      get: async ({ runId, threadId }) => ({ run: await arena.owner(runId, threadId) }),
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
        if (thread.originPluginId === bb.pluginId) await arena.threadChanged(thread.id);
      });
    }
    bb.background.service("arena-recovery", {
      async start(signal) {
        await arena.recover(signal);
        if (signal.aborted) return;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
  },
});
