import { cliCommand } from "@get-bb/plugin-sdk";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";
import { readFile } from "../rpc/read-file.ts";

export function cat(ctx: GitContext) {
  return cliCommand({
    summary: "Print a tweakable file from this thread's machine",
    positionals: [{ name: "path", description: "repo-relative path", required: true }],
    async run({ positionals }, cli) {
      const snapshot = await commandCheckout(ctx, cli);
      const file = await readFile(ctx, { hostId: snapshot.host.id, path: positionals.path });
      return { exitCode: 0, stdout: file.content, stderr: actedOn(snapshot) };
    },
  });
}
