import { CommandError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { runTask } from "../rpc/run-task.ts";

export const render = defineCommand({
  summary: "Render agent configs and settings overlays via mise",
  async execute(ctx) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const result = await runTask.execute(ctx, { task: "render" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
