import { CLIError, defineCommand } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";

export const status = defineCommand({
  summary: "Git status of the dotfiles repo",
  run: async (client: Client) => {
    const overview = await client.overview();
    if (!overview.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${overview.repoPath}`);
    }
    const body = overview.gitEntries
      .map((entry) => `${entry.status.padEnd(2)} ${entry.path}`)
      .join("\n");
    return { exitCode: 0, stdout: `branch: ${overview.branch}\n${body || "clean"}` };
  },
});
