import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand, PluginCliError } from "@bb-kit/core/command";
import { instructionFiles } from "@bb-kit/core/instructions";

const files = instructionFiles(import.meta.url);
const directory = join(files.root, "references", "principles");

export const principle = defineCommand({
  summary: files.read("commands/principle"),
  options: {
    name: { type: "string", description: files.read("commands/principle-name") },
  },
  execute(_ctx, { options }) {
    const names = readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
    if (options.name === undefined) {
      return { exitCode: 0, stdout: names.join("\n") + "\n" };
    }
    if (!names.includes(options.name)) {
      throw new PluginCliError(`Unknown engineering principle: ${options.name}`, {
        code: "unknown_principle",
        hint: "Run bb dev-mode principle to list available names.",
      });
    }
    return { exitCode: 0, stdout: readFileSync(join(directory, `${options.name}.md`), "utf8") };
  },
});
