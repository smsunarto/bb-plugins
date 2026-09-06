import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountTimelineReveal } from "./timeline-reveal.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "timeline-reveal",
    mount: (context) => mountTimelineReveal(context),
  });
});
