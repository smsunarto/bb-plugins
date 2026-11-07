import { useMemo } from "react";
import {
  experimental_useRpcQuery as useRpcQuery,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { BOTS_PLUGIN_ID, rpcContract, type BotMetadata } from "../contract";
import { conversationOwners, sidebarCompletionThread } from "../lib/conversations";
import { isCompleted } from "../lib/completion";

const NO_INPUT = {};

/**
 * The bots and their bindings through bb's shared query cache: every surface
 * reading them (the shelf, thread menus, the Info tab) shares one request,
 * and the server's `bots` tag invalidation refreshes them all.
 */
export function useBotsList(enabled = true) {
  return useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots_list",
    input: NO_INPUT,
    enabled,
  });
}

export type BotsList = NonNullable<ReturnType<typeof useBotsList>["data"]>;

/** The bots as the sidebar sees them, joined to the sidebar's own threads. */
export interface BotsModel {
  list: BotsList | undefined;
  /** Every bot in its saved order, hidden ones included. */
  bots: readonly BotMetadata[];
  /** Bots the shelf shows: hidden-until-activity ones only once woken. */
  shownBotIds: readonly string[];
  /** Hidden bots whose conversations saw activity after they were hidden. */
  wokenBotIds: readonly string[];
  /** The bot a thread belongs to: its own binding or its nearest bound parent's. */
  ownerOf: (threadId: string) => string | null;
  isCompleted: (threadId: string) => boolean;
  /** Each bot's live conversations, for its avatar's activity. */
  threadsByBot: ReadonlyMap<string, readonly PluginSidebarThread[]>;
}

/** `enabled: false` skips the read, for a host that knows Bots is off. */
export function useBotsModel(threads: readonly PluginSidebarThread[], enabled = true): BotsModel {
  const { data: queried } = useBotsList(enabled);
  const list = enabled ? queried : undefined;
  return useMemo(() => {
    const bots = list?.bots ?? [];
    const owners = conversationOwners(
      threads,
      list?.threadBindings ?? [],
      new Set(list?.detachedThreadIds ?? []),
    );
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const completions = new Map(
      (list?.completions ?? []).map(({ threadId, completedAt }) => [
        threadId,
        { threadId, completedAt, reopenedAt: null },
      ]),
    );
    const threadsByBot = new Map<string, PluginSidebarThread[]>();
    for (const thread of threads) {
      const botId = owners.get(thread.id);
      if (botId === undefined || thread.isArchived) continue;
      const group = threadsByBot.get(botId) ?? [];
      group.push(thread);
      threadsByBot.set(botId, group);
    }
    const lastActivity = (botId: string) =>
      (threadsByBot.get(botId) ?? []).reduce(
        (latest, thread) => Math.max(latest, thread.updatedAt, thread.latestAttentionAt),
        0,
      );
    const shownBotIds: string[] = [];
    const wokenBotIds: string[] = [];
    for (const bot of bots) {
      const woken = lastActivity(bot.id) > (bot.hiddenAt ?? Number.MAX_SAFE_INTEGER);
      if (!bot.hiddenUntilActivity || woken) shownBotIds.push(bot.id);
      if (bot.hiddenUntilActivity && woken) wokenBotIds.push(bot.id);
    }
    return {
      list,
      bots,
      shownBotIds,
      wokenBotIds,
      ownerOf: (threadId) => owners.get(threadId) ?? null,
      isCompleted: (threadId) => {
        const thread = byId.get(threadId);
        return (
          thread !== undefined &&
          isCompleted(completions.get(threadId), sidebarCompletionThread(thread))
        );
      },
      threadsByBot,
    };
  }, [list, threads]);
}
