import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { mountFontPreference } from "./app/font-preference.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "ui-font",
    mount: mountFontPreference,
  });
});
