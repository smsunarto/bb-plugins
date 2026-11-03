// @smsunarto/bb-plugin-gtd-sidebar — bb's built-in Thread list, forked, with
// its sections replaced by GTD shelves: Pinned, Next Action, Waiting, SlopCop,
// Snoozed, and Settled. Rows, menus, drag, rename, quick actions, and styling
// are the built-in's own (app/, forked from bb desktop-v0.48.1).
import { definePluginApp, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./naming.css";
import "./shelves.css";
import { PreferencesSync } from "./app/preferences/PreferencesSync.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { ThreadSelectionProvider } from "./app/selection/threadSelection.js";
import { GTD_THREAD_ACTIONS, currentGtdListActions } from "./app/gtd/gtd-actions.js";

function ThreadInbox({ activeThreadId, isCompactViewport, onNavigate }: PluginThreadListProps) {
  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <TooltipProvider>
        <PreferencesSync />
        <ThreadSelectionProvider activeThreadId={activeThreadId}>
          <ProjectList activeThreadId={activeThreadId} onProjectSelect={onNavigate} />
        </ThreadSelectionProvider>
      </TooltipProvider>
    </CompactViewportOverrideProvider>
  );
}

export default definePluginApp((app) => {
  // Versions up to 0.4.x cached the shelves and provider marks in web storage,
  // which bb's uninstall never clears. Drop those entries on the way in.
  try {
    for (const key of ["gtd-sidebar:v1:lifecycle-rows", "gtd-sidebar:v1:providers"]) {
      localStorage.removeItem(key);
    }
  } catch {
    // No web storage here, so nothing was ever left behind.
  }

  app.slots.experimental_threadList({
    id: "inbox",
    title: "GTD Sidebar (inbox)",
    description: "Next Action and Waiting, with the newest arrivals first.",
    component: ThreadInbox,
  });

  for (const action of GTD_THREAD_ACTIONS) app.slots.experimental_threadAction(action);

  app.slots.commandPaletteAction({
    id: "settle-thread",
    title: "GTD Sidebar: settle thread",
    isAvailable: ({ threadId }) => threadId !== null && currentGtdListActions() !== null,
    run: ({ threadId }) => {
      if (threadId !== null) currentGtdListActions()?.settle(threadId);
    },
  });
});
