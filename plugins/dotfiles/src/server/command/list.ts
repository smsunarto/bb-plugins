import { defineCommand, type CommandContext } from "@bb-kit/core/command";

import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";

export const list = defineCommand({
  summary: "List tweakable files with dirty markers on this thread's machine",
  async execute(ctx: CommandContext<GitContext>) {
    const snapshot = await commandCheckout(ctx);
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
