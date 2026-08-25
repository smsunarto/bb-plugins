import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DotfilesPanel } from "./panel.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dotfiles",
    title: "Dotfiles",
    icon: "Settings",
    path: "dotfiles",
    component: DotfilesPanel,
  });
});
