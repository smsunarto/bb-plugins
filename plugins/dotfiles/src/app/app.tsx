import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { sentryAppTelemetry } from "@bb-plugins/sentry/app";
import { DotfilesPage, RepoStatusBadge } from "./page.tsx";
import { DotfilesSidebar } from "./sidebar.tsx";
import { PLUGIN_TELEMETRY } from "../shared/telemetry.ts";

const telemetry = sentryAppTelemetry(PLUGIN_TELEMETRY);

export default definePluginApp(
  telemetry.instrument((app) => {
    app.slots.navPanel({
      id: "dotfiles",
      title: "Dotfiles",
      icon: "dotfiles/plugin",
      path: "dotfiles",
      component: DotfilesPage,
      headerContent: RepoStatusBadge,
      experimental_sidebar: DotfilesSidebar,
    });
  }),
);
