import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { REQUEST_MENTION_PROVIDER, requestMentionSchema } from "../../shared/request-mention.ts";
import { prompt } from "./studio.ts";

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

/** Programmatic context pills resolve current project files when the user sends. */
export function registerRequestMention(bb: BbPluginApi): void {
  bb.ui.registerMentionProvider({
    id: REQUEST_MENTION_PROVIDER,
    label: "Game Studio context",
    search: () => [],
    async resolve(itemId) {
      const { request, ...input } = parseRequestMentionId(itemId);
      const { context } = await prompt(bb, input, request);
      return { context };
    },
  });
}
