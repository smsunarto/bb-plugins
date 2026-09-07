import { argv, CommandError, defineCommand } from "@bb-kit/core/command";
import { z } from "zod";

import { overview } from "../rpc/overview.ts";
import { publish as publishRpc } from "../rpc/publish.ts";
import { runTask } from "../rpc/run-task.ts";

export const sync = defineCommand({
  summary: "Sync the repo; default is consume-only, --publish pushes",
  input: z.object({
    publish: argv.flag(z.boolean().default(false), {
      description: "publish: rebase, push, re-apply, and render",
    }),
  }),
  async execute(ctx, { publish }) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const result = publish
      ? await publishRpc.execute(ctx)
      : await runTask.execute(ctx, { task: "sync:pull" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
