import { defineCommand, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";
import { publish as publishRpc } from "../rpc/publish.ts";
import { runTask } from "../rpc/run-task.ts";

export const sync = defineCommand({
  summary: "Sync the repo on this thread's machine; default is consume-only, --publish pushes",
  options: {
    publish: { type: "boolean", description: "publish: rebase, push, re-apply, and render" },
  },
  async execute(ctx: CommandContext<GitContext>, { options }) {
    const snapshot = await commandCheckout(ctx);
    const hostId = snapshot.host.id;
    const result = options.publish
      ? await publishRpc.execute(ctx, { hostId })
      : await runTask.execute(ctx, { hostId, task: "sync:pull" });
    return { exitCode: result.exitCode, stdout: result.output, stderr: actedOn(snapshot) };
  },
});
