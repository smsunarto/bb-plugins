import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { mountNotificationRenderer } from "./notification-renderer.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "notification-renderer",
    mount({ signal }) {
      void mountNotificationRenderer({ signal }).catch(() => {});
    },
  });
});
