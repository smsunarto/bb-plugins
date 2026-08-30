import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { GitButlerPanel } from "./panel.tsx";

function GitButlerPanelBoundary(props: PluginThreadPanelProps) {
  return (
    <PluginQueryBoundary>
      <GitButlerPanel threadId={props.threadId} />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "gitbutler",
    title: "GitButler",
    icon: "GitBranch",
    layout: "flush",
    component: GitButlerPanelBoundary,
  });
});
