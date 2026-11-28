import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { AccountPoolSettings } from "./settings-section.js";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "accounts",
    component: AccountPoolSettings,
  });
});
