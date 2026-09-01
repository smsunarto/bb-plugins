import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { NovncToggleAction } from "./novnc-toggle-action.tsx";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "novnc",
    scopes: ["thread"],
    actions: [{ id: "novnc-toggle", component: NovncToggleAction }],
  });
});
