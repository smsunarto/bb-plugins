import { CLIError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import type { Context } from "@bb-kit/core/plugin";

export const status = defineCommand({
  summary: "Git status of the dotfiles repo",
  run: async (context: Context) => {
    const snapshot = await overview.handler(context);
    if (!snapshot.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const body = snapshot.gitEntries
      .map((entry) => `${entry.status.padEnd(2)} ${entry.path}`)
      .join("\n");
    return { exitCode: 0, stdout: `branch: ${snapshot.branch}\n${body || "clean"}` };
  },
});
