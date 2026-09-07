import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountTimelineMotion } from "./timeline-motion.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "timeline-fade",
    mount: ({ signal }) => mountTimelineMotion(document, signal),
  });
});
