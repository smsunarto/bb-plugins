import { CommandError, defineCommand } from "@bb-kit/core/cli";

import { overview } from "../rpc/overview.ts";
import { runTask } from "../rpc/run-task.ts";
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
  async execute(ctx, { args }) {
    const snapshot = await overview.execute(ctx);
    if (!snapshot.repoExists) {
      throw new CommandError(`dotfiles repo not found at ${snapshot.repoPath}`);
    }
    const target = args[0];
    const task = target === undefined ? "check" : checkTasks[target];
    if (task === undefined) {
      throw new CommandError(`unknown check target: ${target}`, { exitCode: 2 });
    }
    const result = await runTask.execute(ctx, { task });
    return { exitCode: result.exitCode, stdout: result.output };
  },
});
