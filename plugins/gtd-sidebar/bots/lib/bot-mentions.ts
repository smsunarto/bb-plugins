import type { BbPluginApi, PluginMentionItem } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import type { BotStore } from "./bot-store.ts";

const files = instructionFiles(import.meta.url);

export const BOT_MENTION_LIMIT = 30;
// oxlint-disable-next-line no-control-regex -- strips terminal control characters from names
const displayText = (value: string) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerBotMentions(bb: BbPluginApi, store: BotStore) {
  bb.ui.registerMentionProvider({
    id: "bots",
    label: "Bots",
    triggers: ["@"],
    search({ trigger, query }) {
      if (trigger !== "@") return [];
      const needle = query.trim().toLocaleLowerCase();
      if (needle.length > 256) return [];
      return store
        .list()
        .map((bot, index) => {
          const name = displayText(bot.name).toLocaleLowerCase();
          const role = displayText(bot.role).toLocaleLowerCase();
          const id = bot.id.toLocaleLowerCase();
          const rank =
            !needle || needle === "bots"
              ? 0
              : name === needle
                ? 0
                : name.startsWith(needle)
                  ? 1
                  : name.includes(needle)
                    ? 2
                    : role.includes(needle)
                      ? 3
                      : id.includes(needle)
                        ? 4
                        : -1;
          return { bot, index, rank };
        })
        .filter((entry) => entry.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, BOT_MENTION_LIMIT)
        .map(({ bot }): PluginMentionItem => ({
          id: bot.id,
          title: displayText(bot.name),
          subtitle: [displayText(bot.role) || "Bot", bot.id].join(" · "),
          icon: "Bot",
        }));
    },
    resolve(itemId) {
      // Resolve by stable identity at send time, never by an ambiguous name.
      // Mentioning a bot must not expose its private files or activate it.
      const bot = store.require(itemId);
      const metadata = { botId: bot.id, name: bot.name, role: bot.role };
      return {
        context: files.read("bots/mention", {
          metadata: JSON.stringify(metadata),
          botId: shellQuote(bot.id),
        }),
      };
    },
  });
}
