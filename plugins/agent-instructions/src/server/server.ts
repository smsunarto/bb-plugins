import { defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { add } from "./command/add.ts";
import { list } from "./command/list.ts";
import { preview } from "./command/preview.ts";
import { remove } from "./command/remove.ts";
import { openStore, type AgentInstructionsContext } from "./lib/store.ts";
import { rules, rulesContract } from "./rpc/rules.ts";
import { saveRules, saveRulesContract } from "./rpc/save-rules.ts";
import { targets, targetsContract } from "./rpc/targets.ts";

import { promptContract, promptHandlers } from "../prompts/server/server.ts";

export const contract = defineRpcContract({
  plugins: promptContract.plugins,
  file: promptContract.file,
  save: promptContract.save,
  rules: rulesContract,
  saveRules: saveRulesContract,
  targets: targetsContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: AgentInstructionsContext = Object.freeze({ bb, store: openStore(bb) });
  const { store } = ctx;
  const prompts = promptHandlers(bb);
  bb.rpc.register(contract, {
    plugins: prompts.plugins,
    file: prompts.file,
    save: prompts.save,
    rules: () => rules(ctx),
    saveRules: (input) => saveRules(ctx, input),
    targets: () => targets(ctx),
  });
  bb.cli.register(
    defineCli({
      name: "agent-instructions",
      summary: "CLI for the agent-instructions plugin",
      commands: { list: list(ctx), add: add(ctx), remove: remove(ctx), preview: preview(ctx) },
    }),
  );

  await store.load();
  // `configure`, unlike `contributeInstructions`, sees the host, provider,
  // and model a thread resolves with, which is what rules match on.
  bb.agents.configure((session) => {
    const instructions = store.resolve(session.thread.id, session);
    return { tools: [], skills: [], ...(instructions === null ? {} : { instructions }) };
  });
}
