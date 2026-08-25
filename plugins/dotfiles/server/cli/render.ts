import { CLIError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { runTask } from "../rpc/run-task.ts";
import type { Context } from "@bb-kit/core/plugin";

export const render = defineCommand({
  summary: "Render agent configs and settings overlays via mise",
  run: async (context: Context) => {
    const snapshot = await overview.handler(context);
    if (!snapshot.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const result = await runTask.handler(context, { task: "render" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
