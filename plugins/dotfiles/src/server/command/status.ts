import { cliCommand } from "@get-bb/plugin-sdk";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";

export function status(ctx: GitContext) {
  return cliCommand({
    summary: "Git status of the dotfiles repo on this thread's machine",
    async run(_input, cli) {
      const snapshot = await commandCheckout(ctx, cli);
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
}
