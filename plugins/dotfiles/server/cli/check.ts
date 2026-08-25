import { CLIError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { runTask } from "../rpc/run-task.ts";
import type { Context } from "@bb-kit/core/plugin";
import type { TaskId } from "../domain.ts";

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
  run: async (context: Context, { args }) => {
    const snapshot = await overview.handler(context);
    if (!snapshot.repoExists) {
      throw new CLIError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const target = args[0];
    const task = target === undefined ? "check" : checkTasks[target];
    if (task === undefined) {
      throw new CLIError(`unknown check target: ${target}`, { exitCode: 2 });
    }
    const result = await runTask.handler(context, { task });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
