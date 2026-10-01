import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { overview } from "../rpc/overview.ts";
import { readFile } from "../rpc/read-file.ts";

export const cat = defineCommand({
  summary: "Print a tweakable file",
  positionals: [{ name: "path", description: "repo-relative path", required: true }],
  async execute(ctx: CommandContext<GitContext>, { positionals }) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new PluginCliError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const file = await readFile.execute(ctx, { path: positionals.path });
    return { exitCode: 0, stdout: file.content };
  },
});
