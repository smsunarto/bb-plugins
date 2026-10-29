import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { PromptEditorContext } from "./lib/context.ts";
import { file, fileContract } from "./rpc/file.ts";
import { plugins, pluginsContract } from "./rpc/plugins.ts";
import { save, saveContract } from "./rpc/save.ts";

export const promptContract = defineRpcContract({
  plugins: pluginsContract,
  file: fileContract,
  save: saveContract,
});

export function promptHandlers(bb: BbPluginApi) {
  const ctx: PromptEditorContext = Object.freeze({ bb });
  return {
    plugins: () => plugins(ctx),
    file: (input: Parameters<typeof file>[1]) => file(ctx, input),
    save: (input: Parameters<typeof save>[1]) => save(ctx, input),
  };
}
