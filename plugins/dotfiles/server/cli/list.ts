import { CommandError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";

export const list = defineCommand({
  summary: "List tweakable files with dirty markers",
  async execute(ctx) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
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
    return { exitCode: 0, stdout: lines.join("\n") };
  },
});
