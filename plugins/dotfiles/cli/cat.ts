import { CLIError, defineCommand } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";

export const cat = defineCommand({
  summary: "Print a tweakable file",
  configure: (command) => {
    command.argument("<path>", "repo-relative path");
  },
  run: async (client: Client, { args }) => {
    const overview = await client.overview();
    if (!overview.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${overview.repoPath}`);
    }
    const file = await client.readFile({ path: args[0] ?? "" });
    return { exitCode: 0, stdout: file.content };
  },
});
