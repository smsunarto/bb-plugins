import { REQUEST_MENTION_PROVIDER, requestMentionSchema } from "@argus-labs/game-studio-api";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StudioClient } from "./studio-client.ts";

function parseRequestMentionId(itemId: string) {
  try {
    if (itemId.length > 4096) throw new Error("Context reference exceeds 4096 characters.");
    return requestMentionSchema.parse(JSON.parse(itemId));
  } catch (cause) {
    throw new Error("This Game Studio context reference is invalid. Add the context again.", {
      cause,
    });
  }
}

/** Programmatic context pills resolve the studio's prepared text when the person sends. */
export function registerRequestMention(bb: BbPluginApi, studio: StudioClient): void {
  bb.ui.registerMentionProvider({
    id: REQUEST_MENTION_PROVIDER,
    label: "Game Studio context",
    search: () => [],
    async resolve(itemId) {
      const { gameId, ...input } = parseRequestMentionId(itemId);
      const api = await studio.client();
      const { context } = await api.canvas.prompt(gameId, input);
      return { context };
    },
  });
}
