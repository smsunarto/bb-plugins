import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { overview } from "../rpc/overview.ts";
import { runTask } from "../rpc/run-task.ts";

export const render = defineCommand({
  summary: "Render agent configs and settings overlays via mise",
  async execute(ctx: CommandContext<GitContext>) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new PluginCliError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const result = await runTask.execute(ctx, { task: "render" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
