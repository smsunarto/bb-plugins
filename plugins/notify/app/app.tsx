import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { sentryAppTelemetry } from "@bb-kit/sentry/app";

import { mountNotificationRenderer } from "./notification-renderer.ts";
import { PLUGIN_TELEMETRY } from "../shared/telemetry.ts";

const telemetry = sentryAppTelemetry(PLUGIN_TELEMETRY);

export default definePluginApp(
  telemetry.instrument((app) => {
    app.contentScripts.register({
      id: "notification-renderer",
      mount({ pluginId, signal }) {
        return mountNotificationRenderer({ pluginId, signal });
      },
    });
  }),
);
