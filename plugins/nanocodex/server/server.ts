import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";
import { status } from "./command/status.ts";
import { nanocodexProvider } from "./provider-declaration.ts";

const telemetry = sentryPluginTelemetry({
  pluginId: "nanocodex",
  serverEntryUrl: import.meta.url,
  dsn: "https://56f8b9fe016877d46b7d379c17a1e6ea@o4506475620204544.ingest.us.sentry.io/4511947654758400",
});

export default definePlugin({
  pluginId: "nanocodex",
  errorReporter: telemetry.errorReporter,
  performanceReporter: telemetry.performanceReporter,
  rpc: {},
  command: { status },
  setup(bb) {
    bb.providers.register(nanocodexProvider);
  },
});
