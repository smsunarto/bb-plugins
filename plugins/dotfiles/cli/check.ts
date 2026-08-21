import { CLIError, defineCommand } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";
import type { TaskId } from "../server/domain.ts";

const checkTasks: Readonly<Record<string, TaskId>> = {
  location: "check:location",
  mise: "check:mise",
  shell: "check:shell",
  mcp: "check:mcp",
  python: "check:python",
  skills: "check:skills",
  dotfiles: "check:dotfiles",
  safety: "check:safety",
  secrets: "check:secrets",
};

export const check = defineCommand({
  summary: "Run all validation or one named check target",
  configure: (command) => {
    command.argument("[target]", "location|mise|shell|mcp|python|skills|dotfiles|safety|secrets");
  },
  run: async (client: Client, { args }) => {
    const overview = await client.overview();
    if (!overview.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${overview.repoPath}`);
    }
    const target = args[0];
    const task = target === undefined ? "check" : checkTasks[target];
    if (task === undefined) {
      throw new CLIError(`unknown check target: ${target}`, { exitCode: 2 });
    }
    const result = await client.runTask({ task });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
