import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { PromptEditorContext } from "./lib/context.ts";
import { file, fileContract } from "./rpc/file.ts";
import { plugins, pluginsContract } from "./rpc/plugins.ts";
import { save, saveContract } from "./rpc/save.ts";

export const contract = defineRpcContract({
  plugins: pluginsContract,
  file: fileContract,
  save: saveContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: PromptEditorContext = Object.freeze({ bb });
  bb.rpc.register(contract, {
    plugins: () => plugins(ctx),
    file: (input) => file(ctx, input),
    save: (input) => save(ctx, input),
  });
}
