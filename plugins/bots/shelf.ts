// The Bots shelf's client, for GTD Sidebar's integration. GTD bundles these
// modules and renders the shelf with its own rows; every read and write goes
// to the Bots plugin by id (`BOTS_PLUGIN_ID`), so the shelf shows only while
// Bots is enabled (`useBotsPluginEnabled`).
import {
  experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS,
  experimental_useSidebarThreads as useSidebarThreads,
  type definePluginApp,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { botsActionsBridge } from "./components/bots-controller";
import { useBotsModel, type BotsModel } from "./hooks/use-bots";
import { useBotsPluginEnabled } from "./hooks/use-bots-plugin-enabled";

export { BOTS_PLUGIN_ID, type BotMetadata } from "./contract";
export { useBotsModel, type BotsModel } from "./hooks/use-bots";
export { useBotsPluginEnabled } from "./hooks/use-bots-plugin-enabled";
export {
  botsActionsBridge,
  useBotsController,
  type BotsActions,
} from "./components/bots-controller";
export {
  BotWorkflowRuns,
  WorkflowRunsContext,
  useWorkflowRunsData,
} from "./components/workflow-runs";
export { SidebarBotIcon } from "./components/sidebar-bot-icon";
export { isWorking } from "./lib/conversations";
export { conversationRoots } from "./lib/conversation-order";

/** The `app` that `definePluginApp` hands its setup; the SDK does not export its type. */
type PluginApp = Parameters<Parameters<typeof definePluginApp>[0]>[0];

interface ShelfActionData {
  model: BotsModel;
  threadById: ReadonlyMap<string, PluginSidebarThread>;
}

function useShelfActionData(): ShelfActionData {
  const { threads } = useSidebarThreads();
  const model = useBotsModel(threads, useBotsPluginEnabled() === true);
  return useMemo(
    () => ({ model, threadById: new Map(threads.map((thread) => [thread.id, thread])) }),
    [model, threads],
  );
}

/**
 * The thread-menu entries that open the shelf's dialogs. The registering
 * sidebar mounts the shelf's controller (`useBotsController`); with no shelf
 * mounted, or Bots off, the entries stay hidden.
 */
export function registerBotShelfActions(app: PluginApp) {
  app.slots.experimental_threadAction<ShelfActionData>({
    id: "bot-new-in-worktree",
    title: "New bot conversation in worktree",
    icon: "GitBranch",
    group: THREAD_ACTION_GROUPS.organize,
    useData: useShelfActionData,
    item: ({ thread, data }) => {
      const bot = data.model.bots.find((entry) => entry.id === data.model.ownerOf(thread.id));
      const actions = botsActionsBridge();
      const sidebarThread = data.threadById.get(thread.id);
      if (!bot || !actions || !sidebarThread) return null;
      return {
        label: "New conversation in worktree…",
        icon: "GitBranch",
        disabled: !actions.hasWorkProjects(bot),
        run: () => actions.newInProject(bot, "worktree", sidebarThread),
      };
    },
  });

  app.slots.experimental_threadAction<ShelfActionData>({
    id: "bot-fork",
    title: "Fork bot conversation",
    icon: "Fork",
    group: THREAD_ACTION_GROUPS.organize,
    useData: useShelfActionData,
    item: ({ thread, data }) => {
      const bot = data.model.bots.find((entry) => entry.id === data.model.ownerOf(thread.id));
      const actions = botsActionsBridge();
      const sidebarThread = data.threadById.get(thread.id);
      if (!bot || !actions || !sidebarThread || thread.environment === null) return null;
      return {
        label: "Fork in same environment…",
        icon: "Fork",
        run: () => actions.fork(bot, sidebarThread),
      };
    },
  });
}
