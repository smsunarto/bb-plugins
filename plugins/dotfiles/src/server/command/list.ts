import { cliCommand } from "@get-bb/plugin-sdk";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";

export function list(ctx: GitContext) {
  return cliCommand({
    summary: "List tweakable files with dirty markers on this thread's machine",
    async run(_input, cli) {
      const snapshot = await commandCheckout(ctx, cli);
      const lines: string[] = [];
      for (const group of snapshot.groups) {
        lines.push(`# ${group.title}`);
        for (const file of group.files) {
          const flags = [
            file.dirty ? "dirty" : "",
            file.render ? "renders" : "",
            file.exists ? "" : "MISSING",
          ]
            .filter(Boolean)
            .join(", ");
          lines.push(`  ${file.path}${flags ? `  [${flags}]` : ""}`);
        }
      }
      return { exitCode: 0, stdout: lines.join("\n"), stderr: actedOn(snapshot) };
    },
  });
}
