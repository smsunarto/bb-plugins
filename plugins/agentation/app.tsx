import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import {
  AgentationSettingsSection,
  AnnotationPanel,
  AnnotationPanelHeader,
} from "@/components/annotation-panel.tsx";
import { AgentationStagedAnnotationsAction } from "@/components/staged-annotations-action.tsx";
import { AnnotationToolbarOverlay } from "@/components/annotation-toolbar.tsx";
import { createRpcClient } from "@/lib/plugin-rpc.ts";
import type { rpcContract } from "@/server.ts";

async function toggleToolbar(): Promise<void> {
  try {
    const rpc = createRpcClient<typeof rpcContract>("agentation");
    const { config } = await rpc.call("getConfig");
    await rpc.call("setToolbarEnabled", { enabled: !config.toolbarEnabled });
  } catch (cause) {
    toast.error("Could not change the toolbar", {
      description: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export default definePluginApp((app) => {
  let toolbarToggle = Promise.resolve();

  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "toggle-toolbar",
    label: "Toggle Agentation toolbar",
    icon: "ChatFeedback",
    onActivate() {
      toolbarToggle = toolbarToggle.then(toggleToolbar);
      return toolbarToggle;
    },
  });

  app.slots.experimental_appOverlay({
    id: "annotation-toolbar",
    component: AnnotationToolbarOverlay,
  });

  app.composer.customize({
    id: "staged-annotations",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "staged-annotations", component: AgentationStagedAnnotationsAction }],
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
