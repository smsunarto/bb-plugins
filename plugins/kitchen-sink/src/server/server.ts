import { definePlugin } from "@bb-kit/core/plugin";
import { readInstructions } from "./lib/instructions.ts";

import { registerCompletionSound } from "./lib/completion-sound.ts";
import { registerInlineVisOwner } from "./lib/inline-vis-owner.ts";
import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { registerTimelineMotionSettings } from "./lib/timeline-motion.ts";
import { mentionProviders } from "./mentions.ts";
import { renderEmbed } from "./rpc/render-embed.ts";

export const SMART_EMBED_INSTRUCTIONS = readInstructions("smart-embeds");
export const INLINE_VIS_INSTRUCTIONS = readInstructions("inline-vis");

export default definePlugin({
  pluginId: "kitchen-sink",
  rpc: {
    renderEmbed,
  },
  rpcPublication: {
    discoverable: true,
    description: "Smart Embed citations.",
  },
  setup(bb) {
    registerTimelineMotionSettings(bb);
    for (const provider of mentionProviders) {
      bb.ui.registerMentionProvider(provider);
    }
    registerWorkspaceSignals(bb);
    registerCompletionSound(bb);
    registerInlineVisOwner(bb);
  },
  agents: {
    tools: {},
    instructions: () => `${INLINE_VIS_INSTRUCTIONS}\n\n${SMART_EMBED_INSTRUCTIONS}`,
  },
});
