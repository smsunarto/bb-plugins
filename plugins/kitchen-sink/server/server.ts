import { definePlugin } from "@bb-kit/core/plugin";
import { mentionProviders } from "./mentions.ts";

/**
 * Composer commands ship as skills under `skills/` (bb's `/` menu lists
 * skills, so there is no plugin slash-command surface). Mention providers
 * live in `server/mentions.ts`.
 */
export default definePlugin({
  pluginId: "kitchen-sink",
  rpc: {},
  setup(bb) {
    for (const provider of mentionProviders) {
      bb.ui.registerMentionProvider(provider);
    }
  },
});
