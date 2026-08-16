import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { DotfilesPanel } from "./panel.js";

export function registerDotfilesApp(app: PluginAppBuilder): void {
  app.slots.navPanel({
    id: "dotfiles",
    title: "Dotfiles",
    icon: "Settings",
    path: "dotfiles",
    component: DotfilesPanel,
  });
}
