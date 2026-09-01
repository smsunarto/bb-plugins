import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";
import { commitSelection } from "./rpc/commit-selection.ts";
import { repository } from "./rpc/repository.ts";

const telemetry = sentryPluginTelemetry({
  pluginId: "gitbutler",
  serverEntryUrl: import.meta.url,
});

export default definePlugin({
  pluginId: "gitbutler",
  errorReporter: telemetry.errorReporter,
  performanceReporter: telemetry.performanceReporter,
  rpc: { repository, commitSelection },
});
