import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import {
  AgentationSettingsSection,
  AnnotationPanel,
  AnnotationPanelHeader,
} from "@/components/annotation-panel.tsx";
import { AgentationStagingBanner } from "@/components/staging-banner.tsx";
import { AnnotationToolbarOverlay } from "@/components/annotation-toolbar.tsx";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "annotation-toolbar",
    component: AnnotationToolbarOverlay,
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
