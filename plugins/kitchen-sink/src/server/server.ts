import { definePlugin } from "@bb-kit/core/plugin";
import { readInstructions } from "./lib/instructions.ts";

import { registerCompletionSound } from "./lib/completion-sound.ts";
import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { registerTimelineMotionSettings } from "./lib/timeline-motion.ts";
import { mentionProviders } from "./mentions.ts";
import { preparePreview } from "./rpc/prepare-preview.ts";
import { renderEmbed } from "./rpc/render-embed.ts";

export const SMART_EMBED_INSTRUCTIONS = readInstructions("smart-embeds");
export const INLINE_VIS_INSTRUCTIONS = readInstructions("inline-vis");

export default definePlugin({
  pluginId: "kitchen-sink",
  rpc: {
    renderEmbed,
    preparePreview,
  },
  setup(bb) {
    registerTimelineMotionSettings(bb);
    for (const provider of mentionProviders) {
      bb.ui.registerMentionProvider(provider);
    }
    registerWorkspaceSignals(bb);
    registerCompletionSound(bb);
  },
  agents: {
    tools: {},
    instructions: () => `${SMART_EMBED_INSTRUCTIONS}\n\n${INLINE_VIS_INSTRUCTIONS}`,
  },
});
