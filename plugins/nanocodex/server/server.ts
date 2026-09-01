import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";
import { status } from "./command/status.ts";
import { nanocodexProvider } from "./provider-declaration.ts";

const telemetry = sentryPluginTelemetry({
  pluginId: "nanocodex",
  serverEntryUrl: import.meta.url,
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
