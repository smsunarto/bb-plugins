import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DotfilesFilesTab } from "./files-tab.tsx";
import { DotfilesPage, RepoStatusBadge } from "./page.tsx";
import { DotfilesTasksTab } from "./tasks-tab.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dotfiles",
    title: "Dotfiles",
    icon: "Settings",
    path: "dotfiles",
    component: DotfilesPage,
    headerContent: RepoStatusBadge,
    fixedTabs: [
      {
        panelId: "dotfiles",
        id: "files",
        title: "Files",
        icon: "ListView",
        component: DotfilesFilesTab,
        layout: "flush",
      },
      {
        panelId: "dotfiles",
        id: "tasks",
        title: "Tasks",
        icon: "Play",
        component: DotfilesTasksTab,
        layout: "flush",
      },
    ],
  });
});
