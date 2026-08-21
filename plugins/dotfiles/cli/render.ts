import { CLIError, defineCommand } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";

export const render = defineCommand({
  summary: "Render agent configs and settings overlays via mise",
  run: async (client: Client) => {
    const overview = await client.overview();
    if (!overview.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${overview.repoPath}`);
    }
    const result = await client.runTask({ task: "render" });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
