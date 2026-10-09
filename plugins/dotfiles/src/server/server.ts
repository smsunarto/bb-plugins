import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";
import { cat } from "./command/cat.ts";
import { check } from "./command/check.ts";
import { list } from "./command/list.ts";
import { render } from "./command/render.ts";
import { status } from "./command/status.ts";
import { sync } from "./command/sync.ts";
import { hosts } from "./rpc/hosts.ts";
import { overview } from "./rpc/overview.ts";
import { publish } from "./rpc/publish.ts";
import { readFile } from "./rpc/read-file.ts";
import { removeSkill } from "./rpc/remove-skill.ts";
import { runTask } from "./rpc/run-task.ts";
import { saveFile } from "./rpc/save-file.ts";
import { selectHost } from "./rpc/select-host.ts";
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
  rpc: { hosts, overview, publish, readFile, removeSkill, runTask, saveFile, selectHost },
  command: { cat, check, list, render, status, sync },
  services(bb) {
    return { git: createDotfilesGit(bb) };
  },
});
