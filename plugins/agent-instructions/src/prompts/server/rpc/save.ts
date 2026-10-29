import type { z } from "zod";
import { saveResultSchema, saveSchema } from "../../shared/schema.ts";
import { saveAgentFile } from "../lib/agent-text.ts";
import type { PromptEditorContext } from "../lib/context.ts";
import { installedPlugin } from "../lib/installed.ts";

export const saveContract = {
  input: saveSchema,
  output: saveResultSchema,
};

/**
 * Write the file, then reload its plugin: tool descriptions are captured
 * at registration, so only a reload puts them in front of the agent.
 */
export async function save(
  { bb }: PromptEditorContext,
  input: z.output<typeof saveContract.input>,
): Promise<z.input<typeof saveContract.output>> {
  const content = saveAgentFile(await installedPlugin(bb, input.pluginId), input);
  try {
    await bb.sdk.plugins.reload({ pluginId: input.pluginId });
    return { content, reloadError: null };
  } catch (error) {
    return { content, reloadError: error instanceof Error ? error.message : String(error) };
  }
}
