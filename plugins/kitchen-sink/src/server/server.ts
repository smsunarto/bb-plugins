import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLegacyUnityClaims } from "./lib/legacy-unity-claims.ts";
import type { KitchenSinkContext } from "./lib/context.ts";
import { files } from "./lib/instructions.ts";

import { registerCompletionSound } from "./lib/completion-sound.ts";
import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { registerTimelineMotionSettings } from "./lib/timeline-motion.ts";
import { registerRpivTodos } from "./lib/rpiv-todos.ts";
import { mentionProviders } from "./mentions.ts";
import { renderEmbed, renderEmbedContract } from "./rpc/render-embed.ts";
import { projectScripts, projectScriptsContract } from "./rpc/project-scripts.ts";
import { saveProjectScript, saveProjectScriptContract } from "./rpc/save-project-script.ts";
import { askAgent, askAgentContract } from "./rpc/ask-agent.ts";

export const contract = defineRpcContract({
  renderEmbed: renderEmbedContract,
  projectScripts: projectScriptsContract,
  saveProjectScript: saveProjectScriptContract,
  askAgent: askAgentContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: KitchenSinkContext = Object.freeze({ bb });
  bb.rpc.register(
    contract,
    {
      renderEmbed: (input) => renderEmbed(ctx, input),
      projectScripts: (input) => projectScripts(ctx, input),
      saveProjectScript: (input) => saveProjectScript(ctx, input),
      askAgent: (input) => askAgent(ctx, input),
    },
    {
      experimental_discoverable: true,
      experimental_description: "Smart Embed citations and thread details actions.",
    },
  );
  bb.agents.contributeInstructions(() => files.read("smart-embeds"));

  registerLegacyUnityClaims(bb);
  registerTimelineMotionSettings(bb);
  registerRpivTodos(bb);
  for (const provider of mentionProviders) {
    bb.ui.registerMentionProvider(provider);
  }
  registerWorkspaceSignals(bb);
  registerCompletionSound(bb);
}
