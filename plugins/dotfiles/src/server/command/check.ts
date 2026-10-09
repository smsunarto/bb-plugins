import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";

import type { TaskId } from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";
import { actedOn, commandCheckout } from "../lib/command-checkout.ts";
import { runTask } from "../rpc/run-task.ts";

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
  summary: "Run all validation or one named check target on this thread's machine",
  positionals: [
    {
      name: "target",
      description: "location|mise|shell|mcp|python|skills|dotfiles|safety|secrets",
    },
  ],
  async execute(ctx: CommandContext<GitContext>, { positionals: { target } }) {
    const snapshot = await commandCheckout(ctx);
    const task = target === undefined ? "check" : checkTasks[target];
    if (task === undefined) {
      throw new PluginCliError(`unknown check target: ${target}`, {
        code: "invalid_value",
        exitCode: 2,
      });
    }
    const result = await runTask.execute(ctx, { hostId: snapshot.host.id, task });
    return { exitCode: result.exitCode, stdout: result.output, stderr: actedOn(snapshot) };
  },
});
