import type { z } from "zod";
import { fileRefSchema, fileSchema } from "../../shared/schema.ts";
import { readAgentFile } from "../lib/agent-text.ts";
import type { PromptEditorContext } from "../lib/context.ts";
import { installedPlugin } from "../lib/installed.ts";

export const fileContract = {
  input: fileRefSchema,
  output: fileSchema,
};

export async function file(
  { bb }: PromptEditorContext,
  { pluginId, path }: z.output<typeof fileContract.input>,
): Promise<z.input<typeof fileContract.output>> {
  return readAgentFile(await installedPlugin(bb, pluginId), path);
}
