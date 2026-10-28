import { cliCommand } from "@get-bb/plugin-sdk";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";
import { runTask } from "../rpc/run-task.ts";

export function render(ctx: GitContext) {
  return cliCommand({
    summary: "Render agent configs and settings overlays via mise on this thread's machine",
    async run(_input, cli) {
      const snapshot = await commandCheckout(ctx, cli);
      const result = await runTask(ctx, { hostId: snapshot.host.id, task: "render" });
      return { exitCode: result.exitCode, stdout: result.output, stderr: actedOn(snapshot) };
    },
  });
}
