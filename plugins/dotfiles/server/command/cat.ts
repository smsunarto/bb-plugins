import { argv, CommandError, defineCommand } from "@bb-kit/core/command";
import { z } from "zod";

import { overview } from "../rpc/overview.ts";
import { readFile } from "../rpc/read-file.ts";

export const cat = defineCommand({
  summary: "Print a tweakable file",
  input: z.object({
    path: argv.argument(z.string(), { description: "repo-relative path" }),
  }),
  async execute(ctx, { path }) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const file = await readFile.execute(ctx, { path });
    return { exitCode: 0, stdout: file.content };
  },
});
