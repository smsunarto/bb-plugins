import { editors as editorCommand } from "./command/editors.ts";
import { editors as editorTool } from "./tools/editors.ts";
import { createUnityEditors } from "./lib/unity-editors.ts";
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
  command: { editors: editorCommand },
  services(bb) {
    return { unityEditors: createUnityEditors(bb) };
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
    tools: { editors: editorTool },
    instructions: () => files.read("smart-embeds"),
  },
});
