import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";
import { cat } from "./command/cat.ts";
import { check } from "./command/check.ts";
import { list } from "./command/list.ts";
import { render } from "./command/render.ts";
import { status } from "./command/status.ts";
import { sync } from "./command/sync.ts";
import { overview } from "./rpc/overview.ts";
import { publish } from "./rpc/publish.ts";
import { readFile } from "./rpc/read-file.ts";
import { removeSkill } from "./rpc/remove-skill.ts";
import { runTask } from "./rpc/run-task.ts";
import { saveFile } from "./rpc/save-file.ts";
import { createDotfilesGit } from "./git.ts";
import { PLUGIN_TELEMETRY } from "../shared/telemetry.ts";

const telemetry = sentryPluginTelemetry({
  ...PLUGIN_TELEMETRY,
  serverEntryUrl: import.meta.url,
});

export default definePlugin({
  pluginId: "dotfiles",
  errorReporter: telemetry.errorReporter,
  performanceReporter: telemetry.performanceReporter,
  rpc: { overview, publish, readFile, removeSkill, runTask, saveFile },
  command: { cat, check, list, render, status, sync },
  services(bb) {
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
    bb.onDispose(() => git.dispose());
    return { git };
  },
  async setup({ bb, git }) {
    const repoPath = await git.getRepoPath();
    if (!git.repoExists(repoPath)) {
      bb.status.needsConfiguration(
        `Dotfiles repo not found at ${repoPath}. Configure repoPath in the Dotfiles plugin settings.`,
      );
    }
  },
});
