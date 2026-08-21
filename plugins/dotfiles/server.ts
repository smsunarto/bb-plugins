import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { definePlugin } from "@bb-kit/core/plugin";
import { defineRPC, type ClientFor } from "@bb-kit/core/rpc";
import { cat } from "./cli/cat.ts";
import { check } from "./cli/check.ts";
import { list } from "./cli/list.ts";
import { render } from "./cli/render.ts";
import { status } from "./cli/status.ts";
import { sync } from "./cli/sync.ts";
import { overview } from "./rpc/overview.ts";
import { publish } from "./rpc/publish.ts";
import { readFile } from "./rpc/read-file.ts";
import { removeSkill } from "./rpc/remove-skill.ts";
import { runTask } from "./rpc/run-task.ts";
import { saveFile } from "./rpc/save-file.ts";
import { createContext } from "./server/context.ts";

export const rpc = defineRPC({
  namespace: "dotfiles",
  procedures: { overview, publish, readFile, removeSkill, runTask, saveFile },
});

/** The contract type ui/rpc.ts and cli/ commands bind against. */
export type RPC = typeof rpc;

/** The full client type cli/ commands annotate. */
export type Client = ClientFor<RPC>;

export default definePlugin({
  rpc,
  cli: {
    summary: "Manage the tweakable dotfiles repo (list, status, cat, render, check, sync)",
    commands: { cat, check, list, render, status, sync },
  },
  context: createContext,
  async setup(bb: BbPluginApi, { context }) {
    const repoPath = await context.repository.getRepoPath();
    if (!context.repository.repoExists(repoPath)) {
      bb.status.needsConfiguration(
        `Dotfiles repo not found at ${repoPath}. Configure repoPath in the Dotfiles plugin settings.`,
      );
    }
  },
});
