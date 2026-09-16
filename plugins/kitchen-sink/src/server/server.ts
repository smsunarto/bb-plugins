import { definePlugin } from "@bb-kit/core/plugin";
import { autorouterPolicy } from "./tools/autorouter-policy.ts";
import { readInstructions } from "./lib/instructions.ts";

import { registerCompletionSound } from "./lib/completion-sound.ts";
import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { registerTimelineMotionSettings } from "./lib/timeline-motion.ts";
import { mentionProviders } from "./mentions.ts";
import { preparePreview } from "./rpc/prepare-preview.ts";
import { renderEmbed } from "./rpc/render-embed.ts";
import { registerAutorouterSettings, autorouterAgentEnabled } from "./lib/autorouter/settings.ts";
import { getAutorouterProjectIndex } from "./rpc/get-autorouter-project-index.ts";
import { saveAutorouterProjectIndex } from "./rpc/save-autorouter-project-index.ts";
import { updateAutorouterEnabled } from "./rpc/update-autorouter-enabled.ts";
import { updateAutorouterSettings } from "./rpc/update-autorouter-settings.ts";
import { routeAutorouterPrompt } from "./rpc/route-autorouter-prompt.ts";

export const SMART_EMBED_INSTRUCTIONS = readInstructions("smart-embeds");
export const INLINE_VIS_INSTRUCTIONS = readInstructions("inline-vis");
const AUTOROUTER_AGENT_INSTRUCTIONS = readInstructions("autorouter");

export default definePlugin({
  pluginId: "kitchen-sink",
  rpc: {
    renderEmbed,
    preparePreview,
    getAutorouterProjectIndex,
    saveAutorouterProjectIndex,
    updateAutorouterEnabled,
    updateAutorouterSettings,
    routeAutorouterPrompt,
  },
  async setup(bb) {
    await registerAutorouterSettings(bb);
    registerTimelineMotionSettings(bb);
    for (const provider of mentionProviders) {
      bb.ui.registerMentionProvider(provider);
    }
    registerWorkspaceSignals(bb);
    registerCompletionSound(bb);
  },
  agents: {
    tools: { autorouter_policy: autorouterPolicy },
    instructions({ bb }) {
      return (
        `${SMART_EMBED_INSTRUCTIONS}\n\n${INLINE_VIS_INSTRUCTIONS}` +
        (autorouterAgentEnabled(bb) ? `\n\n${AUTOROUTER_AGENT_INSTRUCTIONS}` : "")
      );
    },
  },
});
