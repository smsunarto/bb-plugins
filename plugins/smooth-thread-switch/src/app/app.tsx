import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountTimelineMotion } from "./timeline-motion.ts";
import { PROBE_GROUP_TITLE, ThreadActivityProbe } from "./thread-activity-probe.tsx";

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "thread-activity-probe",
    title: PROBE_GROUP_TITLE,
    component: ThreadActivityProbe,
  });
  app.contentScripts.register({
    id: "timeline-fade",
    mount: ({ signal }) => mountTimelineMotion(document, signal),
  });
});
