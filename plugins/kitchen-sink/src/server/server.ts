import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLegacyUnityClaims } from "./lib/legacy-unity-claims.ts";
import type { KitchenSinkContext } from "./lib/context.ts";

import { migrateStorage } from "./lib/storage-migrations.ts";
import { registerCompletionSound } from "./lib/completion-sound.ts";
import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { registerTimelineMotionSettings } from "./lib/timeline-motion.ts";
import { registerRpivTodos } from "./lib/rpiv-todos.ts";
import { mentionProviders } from "./mentions.ts";
import { projectScripts, projectScriptsContract } from "./rpc/project-scripts.ts";
import { saveProjectScript, saveProjectScriptContract } from "./rpc/save-project-script.ts";

export const contract = defineRpcContract({
  projectScripts: projectScriptsContract,
  saveProjectScript: saveProjectScriptContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  migrateStorage(bb);
  const ctx: KitchenSinkContext = Object.freeze({ bb });
  bb.rpc.register(
    contract,
    {
      projectScripts: (input) => projectScripts(ctx, input),
      saveProjectScript: (input) => saveProjectScript(ctx, input),
    },
    {
      experimental_discoverable: true,
      experimental_description: "Project scripts for the thread details card.",
    },
  );

  registerLegacyUnityClaims(bb);
  registerTimelineMotionSettings(bb);
  registerRpivTodos(bb);
  for (const provider of mentionProviders) {
    bb.ui.registerMentionProvider(provider);
  }
  registerWorkspaceSignals(bb);
  registerCompletionSound(bb);
}
