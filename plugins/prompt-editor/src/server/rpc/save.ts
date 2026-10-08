import { defineMutation } from "@bb-kit/core/rpc";
import { saveResultSchema, saveSchema } from "../../shared/schema.ts";
import { saveAgentFile } from "../lib/agent-text.ts";
import { installedPlugin } from "../lib/installed.ts";

/**
 * Write the file, then reload its plugin: tool descriptions are captured
 * at registration, so only a reload puts them in front of the agent.
 */
export const save = defineMutation({
  input: saveSchema,
  output: saveResultSchema,
  async execute({ bb }, input) {
    const content = saveAgentFile(await installedPlugin(bb, input.pluginId), input);
    try {
      await bb.sdk.plugins.reload({ pluginId: input.pluginId });
      return { content, reloadError: null };
    } catch (error) {
      return { content, reloadError: error instanceof Error ? error.message : String(error) };
    }
  },
});
