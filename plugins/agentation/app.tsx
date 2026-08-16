// @smsunarto/bb-plugin-agentation — frontend entry.
//
// Three surfaces, one job:
// - a content script that mounts the Agentation toolbar over the bb app shell,
//   so every route and every plugin-drawn element can be annotated;
// - a thread-composer banner that shows and assigns the shared staged batch;
// - a nav panel that reads the collected annotations back, with the reply
//   thread an agent may have opened on each one.
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import {
  AgentationSettingsSection,
  AnnotationPanel,
  AnnotationPanelHeader,
} from "@/components/annotation-panel.tsx";
import { AgentationStagingBanner } from "@/components/staging-banner.tsx";
import { mountAnnotationToolbar } from "@/lib/toolbar.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "annotation-toolbar",
    mount: mountAnnotationToolbar,
  });

  app.composer.customize({
    id: "staged-annotations",
    scopes: ["thread"],
    banners: [
      {
        id: "staged-annotations",
        chrome: "bare",
        component: AgentationStagingBanner,
      },
    ],
  });

  app.slots.navPanel({
    id: "annotations",
    title: "Agentation",
    icon: "ChatFeedback",
    path: "annotations",
    component: AnnotationPanel,
    headerContent: AnnotationPanelHeader,
  });

  app.slots.settingsSection({
    id: "about",
    title: "How this works",
    component: AgentationSettingsSection,
  });
});
