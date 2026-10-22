import { defineCommand, PluginCliError } from "@bb-kit/core/command";
import { instructionFiles } from "@bb-kit/core/instructions";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";

const files = instructionFiles(import.meta.url);

export const prompt = defineCommand({
  summary: files.read("commands/prompt"),
  options: {
    request: {
      type: "string",
      required: true,
      description: files.read("commands/prompt-request"),
    },
  },
  execute(_ctx, { options }) {
    if (!options.request.trim()) throw new PluginCliError("The review request must not be empty.");
    const stdout = `${files.read("reviewer")}\n\n## Review request\n\n${options.request}\n`;
    if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES)
      throw new PluginCliError(
        "The review prompt exceeds the CLI byte limit. Shorten the request.",
      );
    return { exitCode: 0, stdout };
  },
});
