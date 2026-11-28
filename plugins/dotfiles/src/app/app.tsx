import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DotfilesPage, RepoStatusBadge } from "./page.tsx";
import { DotfilesSidebar } from "./sidebar.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dotfiles",
    title: "Dotfiles",
    icon: "dotfiles/plugin",
    path: "dotfiles",
    component: DotfilesPage,
    headerContent: RepoStatusBadge,
    experimental_sidebar: DotfilesSidebar,
  });
});
