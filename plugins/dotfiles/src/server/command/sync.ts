import { cliCommand } from "@get-bb/plugin-sdk";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";
import { publish as publishRpc } from "../rpc/publish.ts";
import { runTask } from "../rpc/run-task.ts";

export function sync(ctx: GitContext) {
  return cliCommand({
    summary: "Sync the repo on this thread's machine; default is consume-only, --publish pushes",
    options: {
      publish: { type: "boolean", description: "publish: rebase, push, re-apply, and render" },
    },
    async run({ options }, cli) {
      const snapshot = await commandCheckout(ctx, cli);
      const hostId = snapshot.host.id;
      const result = options.publish
        ? await publishRpc(ctx, { hostId })
        : await runTask(ctx, { hostId, task: "sync:pull" });
      return { exitCode: result.exitCode, stdout: result.output, stderr: actedOn(snapshot) };
    },
  });
}
