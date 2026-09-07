import { CommandError, defineCommand } from "@bb-kit/core/command";

import { overview } from "../rpc/overview.ts";

export const status = defineCommand({
  summary: "Git status of the dotfiles repo",
  async execute(ctx) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const body = snapshot.gitEntries
      .map((entry) => `${entry.status.padEnd(2)} ${entry.path}`)
      .join("\n");
    return { exitCode: 0, stdout: `branch: ${snapshot.branch}\n${body || "clean"}` };
  },
});
