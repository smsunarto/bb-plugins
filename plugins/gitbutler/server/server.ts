import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";
import { commitSelection } from "./rpc/commit-selection.ts";
import { repository } from "./rpc/repository.ts";

const telemetry = sentryPluginTelemetry({
  pluginId: "gitbutler",
  serverEntryUrl: import.meta.url,
  dsn: "https://56f8b9fe016877d46b7d379c17a1e6ea@o4506475620204544.ingest.us.sentry.io/4511947654758400",
});

export default definePlugin({
  pluginId: "gitbutler",
  errorReporter: telemetry.errorReporter,
  performanceReporter: telemetry.performanceReporter,
  rpc: { repository, commitSelection },
});
