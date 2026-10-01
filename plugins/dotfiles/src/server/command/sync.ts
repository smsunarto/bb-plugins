import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { overview } from "../rpc/overview.ts";
import { publish as publishRpc } from "../rpc/publish.ts";
import { runTask } from "../rpc/run-task.ts";

export const sync = defineCommand({
  summary: "Sync the repo; default is consume-only, --publish pushes",
  options: {
    publish: { type: "boolean", description: "publish: rebase, push, re-apply, and render" },
  },
  async execute(ctx: CommandContext<GitContext>, { options }) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new PluginCliError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const result = options.publish
      ? await publishRpc.execute(ctx)
      : await runTask.execute(ctx, { task: "sync:pull" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
