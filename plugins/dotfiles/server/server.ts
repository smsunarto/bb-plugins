import { definePlugin } from "@bb-kit/core/plugin";
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
import { bindGit, createDotfilesGit } from "./git.ts";

export default definePlugin({
  pluginId: "dotfiles",
  rpc: { overview, publish, readFile, removeSkill, runTask, saveFile },
  cli: { cat, check, list, render, status, sync },
  async setup(bb) {
    const settings = bb.settings.define({
      repoPath: {
        type: "string",
        label: "Dotfiles repo path (on the bb server host)",
        default: "~/git/dotfiles",
      },
    });
    const git = createDotfilesGit({
      files: bb.sdk.files,
      getConfiguredRepoPath: async () => (await settings.get()).repoPath,
    });
    bindGit(bb, git);
    bb.onDispose(() => git.dispose());
    const repoPath = await git.getRepoPath();
    if (!git.repoExists(repoPath)) {
      bb.status.needsConfiguration(
        `Dotfiles repo not found at ${repoPath}. Configure repoPath in the Dotfiles plugin settings.`,
      );
    }
  },
});
