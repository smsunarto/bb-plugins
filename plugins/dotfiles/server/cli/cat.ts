import { CommandError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { readFile } from "../rpc/read-file.ts";

export const cat = defineCommand({
  summary: "Print a tweakable file",
  configure: (command) => {
    command.argument("<path>", "repo-relative path");
  },
  async execute(ctx, { args }) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const file = await readFile.execute(ctx, { path: args[0] ?? "" });
    return { exitCode: 0, stdout: file.content };
  },
});
