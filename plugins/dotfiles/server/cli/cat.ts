import { CLIError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { readFile } from "../rpc/read-file.ts";
import type { Context } from "@bb-kit/core/plugin";

export const cat = defineCommand({
  summary: "Print a tweakable file",
  configure: (command) => {
    command.argument("<path>", "repo-relative path");
  },
  run: async (context: Context, { args }) => {
    const snapshot = await overview.handler(context);
    if (!snapshot.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const file = await readFile.handler(context, { path: args[0] ?? "" });
    return { exitCode: 0, stdout: file.content };
  },
});
