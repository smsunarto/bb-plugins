import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "timeline-fade",
    mount: () => undefined,
  });
});
