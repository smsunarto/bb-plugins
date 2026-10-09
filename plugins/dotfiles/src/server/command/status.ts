import { defineCommand, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";

export const status = defineCommand({
  summary: "Git status of the dotfiles repo on this thread's machine",
  async execute(ctx: CommandContext<GitContext>) {
    const snapshot = await commandCheckout(ctx);
    const body = snapshot.gitEntries
      .map((entry) => `${entry.status.padEnd(2)} ${entry.path}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: `branch: ${snapshot.branch}\n${body || "clean"}`,
      stderr: actedOn(snapshot),
    };
  },
});
