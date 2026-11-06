import { useMemo } from "react";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS as THREAD_INFO_ROW_GROUPS,
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
  type PluginRpcClient,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { rpcContract } from "./contract";
import { useBotsModel, type BotsModel } from "./hooks/use-bots";
import { botsActionsBridge } from "./components/bots-controller";
import {
  announceBotChange,
  ThreadBotInfoRow,
  ThreadBotPromptSection,
} from "./components/thread-bot-picker";
import { isBusy } from "./lib/conversations";

const NONE = "__no_bot__";

/** The `app` that `definePluginApp` hands its setup; the SDK does not export its type. */
type PluginApp = Parameters<Parameters<typeof definePluginApp>[0]>[0];

interface BotActionData {
  model: BotsModel;
  rpc: PluginRpcClient<typeof rpcContract>;
  threadById: ReadonlyMap<string, PluginSidebarThread>;
}

/** One read of the bots and the sidebar's threads for every bot action in every open menu. */
function useBotActionData(): BotActionData {
  const { threads } = useSidebarThreads();
  const model = useBotsModel(threads);
  const rpc = useRpc<typeof rpcContract>();
  return useMemo(
    () => ({ model, rpc, threadById: new Map(threads.map((thread) => [thread.id, thread])) }),
    [model, rpc, threads],
  );
}

const report = (cause: unknown) =>
  toast.error(cause instanceof Error ? cause.message : String(cause));

/**
 * The bot surfaces outside the Bots shelf: the thread Info tab's Bot row and
 * prompt preview, and bot entries in every thread menu, GTD's rows included.
 */
export function registerBotsApp(app: PluginApp) {
  app.slots.experimental_threadInfoRow({
    id: "thread-bot",
    group: THREAD_INFO_ROW_GROUPS.thread,
    component: ThreadBotInfoRow,
  });
  // "0_bot" sorts before bb's own sections, so it sits right below the details rows.
  app.slots.experimental_threadInfoSection({
    id: "thread-bot-prompt",
    group: "0_bot",
    component: ThreadBotPromptSection,
  });

  app.slots.experimental_threadAction<BotActionData>({
    id: "bot",
    title: "Bot",
    icon: "Bot",
    group: THREAD_ACTION_GROUPS.organize,
    useData: useBotActionData,
    item: ({ thread, data }) => {
      const { bots } = data.model;
      if (bots.length === 0 || thread.archivedAt !== null) return null;
      const owner = data.model.ownerOf(thread.id);
      const current = bots.find((bot) => bot.id === owner);
      return {
        label: "Bot",
        detail: current?.name ?? "No bot",
        icon: "Bot",
        choices: {
          heading: "Bot",
          hint: "Child conversations move with it.",
          items: [
            { id: NONE, label: "No bot", selected: owner === null },
            ...bots.map((bot) => ({
              id: bot.id,
              label: bot.name,
              icon: "Bot" as const,
              selected: bot.id === owner,
            })),
          ],
        },
        run: async ({ value }) => {
          const botId = value === undefined || value === NONE ? null : value;
          if (botId === owner) return;
          try {
            const result = await data.rpc.call("conversation_set_bot", {
              threadId: thread.id,
              botId,
            });
            announceBotChange(
              botId ? (bots.find((bot) => bot.id === botId)?.name ?? "bot") : null,
              result.threadIds,
            );
          } catch (cause) {
            report(cause);
          }
        },
      };
    },
  });

  app.slots.experimental_threadAction<BotActionData>({
    id: "bot-complete",
    title: "Mark bot conversation complete",
    icon: "CircleCheck",
    group: THREAD_ACTION_GROUPS.organize,
    useData: useBotActionData,
    item: ({ thread, data }) => {
      if (data.model.ownerOf(thread.id) === null || thread.archivedAt !== null) return null;
      const completed = data.model.isCompleted(thread.id);
      const sidebarThread = data.threadById.get(thread.id);
      return {
        label: completed ? "Mark incomplete" : "Mark complete",
        icon: "CircleCheck",
        // Live work cannot complete; it would reopen on its next event anyway.
        disabled: !completed && sidebarThread !== undefined && isBusy(sidebarThread),
        run: () => {
          const actions = botsActionsBridge();
          if (actions) actions.setCompleted(thread.id, !completed);
          else
            void data.rpc
              .call("conversation_complete", { threadId: thread.id, completed: !completed })
              .catch(report);
        },
      };
    },
  });

  app.slots.experimental_threadAction<BotActionData>({
    id: "bot-new-in-worktree",
    title: "New bot conversation in worktree",
    icon: "GitBranch",
    group: THREAD_ACTION_GROUPS.organize,
    useData: useBotActionData,
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

  app.slots.experimental_threadAction<BotActionData>({
    id: "bot-fork",
    title: "Fork bot conversation",
    icon: "Fork",
    group: THREAD_ACTION_GROUPS.organize,
    useData: useBotActionData,
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
