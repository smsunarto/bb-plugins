import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { sentryAppTelemetry } from "@bb-plugins/sentry/app";
import { DotfilesFilesTab, DotfilesWorkflowsTab } from "./files-tab.tsx";
import { DotfilesPage, RepoStatusBadge } from "./page.tsx";
import { DotfilesTasksTab } from "./tasks-tab.tsx";
import { PLUGIN_TELEMETRY } from "../shared/telemetry.ts";

const telemetry = sentryAppTelemetry(PLUGIN_TELEMETRY);

export default definePluginApp(
  telemetry.instrument((app) => {
    app.slots.navPanel({
      id: "dotfiles",
      title: "Dotfiles",
      icon: "Settings",
      path: "dotfiles",
      component: DotfilesPage,
      headerContent: RepoStatusBadge,
    });
    app.slots.experimental_tab({
      context: { kind: "nav-panel", panelId: "dotfiles" },
      availability: "fixed",
      id: "files",
      title: "Files",
      icon: "ListView",
      component: DotfilesFilesTab,
      layout: "flush",
    });
    app.slots.experimental_tab({
      context: { kind: "nav-panel", panelId: "dotfiles" },
      availability: "fixed",
      id: "workflows",
      title: "Workflows",
      icon: "ListView",
      component: DotfilesWorkflowsTab,
      layout: "flush",
    });
    app.slots.experimental_tab({
      context: { kind: "nav-panel", panelId: "dotfiles" },
      availability: "fixed",
      id: "tasks",
      title: "Tasks",
      icon: "Play",
      component: DotfilesTasksTab,
      layout: "flush",
    });
  }),
);
