import { CommandError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { publish } from "../rpc/publish.ts";
import { runTask } from "../rpc/run-task.ts";

export const sync = defineCommand({
  summary: "Sync the repo; default is consume-only, --publish pushes",
  configure: (command) => {
    command.option("--publish", "publish: rebase, push, re-apply, and render");
  },
  async execute(ctx, { options }) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const result = options["publish"]
      ? await publish.execute(ctx)
      : await runTask.execute(ctx, { task: "sync:pull" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
