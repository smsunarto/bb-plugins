import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { registerLegacyUnityClaims } from "./lib/legacy-unity-claims.ts";
import type { KitchenSinkContext } from "./lib/context.ts";

import { migrateStorage } from "./lib/storage-migrations.ts";
import { registerCompletionSound } from "./lib/completion-sound.ts";
import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { registerRpivTodos } from "./lib/rpiv-todos.ts";
import { SAUCE_PROJECT_PATTERN, SAUCE_TOOLS, registerSauceTools } from "./lib/sauce/tools.ts";
import { mentionProviders } from "./mentions.ts";
import { projectScripts, projectScriptsContract } from "./rpc/project-scripts.ts";
import { saveProjectScript, saveProjectScriptContract } from "./rpc/save-project-script.ts";

export const contract = defineRpcContract({
  projectScripts: projectScriptsContract,
  saveProjectScript: saveProjectScriptContract,
});

/** Every skill under skills/; configure must name them all, or selecting tools would hide them. */
export const SKILLS = ["project-scripts", "sauce-live", "subthread", "test-remotely"];

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
  registerRpivTodos(bb);
  for (const provider of mentionProviders) {
    bb.ui.registerMentionProvider(provider);
  }
  registerWorkspaceSignals(bb);
  registerCompletionSound(bb);

  registerSauceTools(bb);
  bb.agents.configure((context) => {
    const sauce =
      SAUCE_PROJECT_PATTERN.test(context.project.name) ||
      SAUCE_PROJECT_PATTERN.test(context.project.gitRemoteUrl ?? "");
    return { tools: sauce ? [...SAUCE_TOOLS] : [], skills: SKILLS };
  });
}
