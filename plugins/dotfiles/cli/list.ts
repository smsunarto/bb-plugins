import { CLIError, defineCommand } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";

export const list = defineCommand({
  summary: "List tweakable files with dirty markers",
  run: async (client: Client) => {
    const overview = await client.overview();
    if (!overview.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${overview.repoPath}`);
    }
    const lines: string[] = [];
    for (const group of overview.groups) {
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
