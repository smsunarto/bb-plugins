import { defineCommand, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";
import { readFile } from "../rpc/read-file.ts";

export const cat = defineCommand({
  summary: "Print a tweakable file from this thread's machine",
  positionals: [{ name: "path", description: "repo-relative path", required: true }],
  async execute(ctx: CommandContext<GitContext>, { positionals }) {
    const snapshot = await commandCheckout(ctx);
    const file = await readFile.execute(ctx, { hostId: snapshot.host.id, path: positionals.path });
    return { exitCode: 0, stdout: file.content, stderr: actedOn(snapshot) };
  },
});
