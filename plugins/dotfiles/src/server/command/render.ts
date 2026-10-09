import { defineCommand, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";
import { runTask } from "../rpc/run-task.ts";

export const render = defineCommand({
  summary: "Render agent configs and settings overlays via mise on this thread's machine",
  async execute(ctx: CommandContext<GitContext>) {
    const snapshot = await commandCheckout(ctx);
    const result = await runTask.execute(ctx, { hostId: snapshot.host.id, task: "render" });
    return { exitCode: result.exitCode, stdout: result.output, stderr: actedOn(snapshot) };
  },
});
