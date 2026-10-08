import { definePlugin } from "@bb-kit/core/plugin";
import { files } from "./lib/instructions.ts";

import { registerCompletionSound } from "./lib/completion-sound.ts";
import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { registerTimelineMotionSettings } from "./lib/timeline-motion.ts";
import { mentionProviders } from "./mentions.ts";
import { renderEmbed } from "./rpc/render-embed.ts";

export default definePlugin({
  pluginId: "kitchen-sink",
  rpc: {
    renderEmbed,
  },
  rpcPublication: {
    discoverable: true,
    description: "Smart Embed citations.",
  },
  setup({ bb }) {
    registerTimelineMotionSettings(bb);
    for (const provider of mentionProviders) {
      bb.ui.registerMentionProvider(provider);
    }
    registerWorkspaceSignals(bb);
    registerCompletionSound(bb);
  },
  agents: {
    files,
    tools: {},
    instructions: () => files.read("smart-embeds"),
  },
});
