import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract.ts";
import type { BotStore } from "./bot-store.ts";
import { messageExcerpt } from "./message-excerpt.ts";

interface LastMessage {
  threadId: string;
  text: string;
  at: number;
}

const OUTPUT_DEADLINE_MS = 5000;
const key = (botId: string) => `last-message:${botId}`;

/**
 * Each bot's latest main-chat reply, as the one-line preview the Bots tab
 * shows under its name. Saved when the main chat goes idle; a main chat that
 * replied before this plugin tracked it is read once in the background.
 */
export function createLastMessages(
  bb: BbPluginApi,
  store: Pick<BotStore, "list" | "state" | "setState">,
  publish: () => void,
) {
  const save = (botId: string, threadId: string, text: string | null) => {
    const excerpt = messageExcerpt(text);
    if (excerpt === null) return;
    store.setState(key(botId), { threadId, text: excerpt, at: Date.now() } satisfies LastMessage);
    publish();
  };

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const bot = store.list().find((entry) => entry.mainThreadId === thread.id);
    if (bot) save(bot.id, thread.id, lastAssistantText);
  });

  // One read per main chat per server run, off the list's critical path.
  const backfilled = new Set<string>();
  function backfill(bot: BotMetadata, threadId: string) {
    if (backfilled.has(threadId)) return;
    backfilled.add(threadId);
    void (async () => {
      const { output } = await bb.sdk.threads.output({
        threadId,
        signal: AbortSignal.timeout(OUTPUT_DEADLINE_MS),
      });
      // A reply that arrived meanwhile is newer than this read.
      if (store.state<LastMessage>(key(bot.id))?.threadId !== threadId)
        save(bot.id, threadId, output);
    })().catch(() => {});
  }

  return {
    list(bots: readonly BotMetadata[]) {
      const entries: { botId: string; text: string; at: number }[] = [];
      for (const bot of bots) {
        const saved = store.state<LastMessage>(key(bot.id));
        if (bot.mainThreadId && saved?.threadId !== bot.mainThreadId)
          backfill(bot, bot.mainThreadId);
        if (saved) entries.push({ botId: bot.id, text: saved.text, at: saved.at });
      }
      return entries;
    },
  };
}
