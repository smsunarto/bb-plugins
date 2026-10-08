import { defineQuery } from "@bb-kit/core/rpc";
import { fileRefSchema, fileSchema } from "../../shared/schema.ts";
import { readAgentFile } from "../lib/agent-text.ts";
import { installedPlugin } from "../lib/installed.ts";

export const file = defineQuery({
  input: fileRefSchema,
  output: fileSchema,
  async execute({ bb }, { pluginId, path }) {
    return readAgentFile(await installedPlugin(bb, pluginId), path);
  },
});
