import { CLIError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { publish } from "../rpc/publish.ts";
import { runTask } from "../rpc/run-task.ts";
import type { Context } from "@bb-kit/core/plugin";

export const sync = defineCommand({
  summary: "Sync the repo; default is consume-only, --publish pushes",
  configure: (command) => {
    command.option("--publish", "publish: rebase, push, re-apply, and render");
  },
  run: async (context: Context, { options }) => {
    const snapshot = await overview.handler(context);
    if (!snapshot.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const result = options["publish"]
      ? await publish.handler(context)
      : await runTask.handler(context, { task: "sync:pull" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
