import { cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import { isJsonObject, parseJsonText } from "../../shared/vendor/json/src/index.ts";
import type { WhiteboardContext } from "../lib/context.ts";
import { capOutput } from "../lib/tools/cli-output.ts";
import { bbToolName } from "../lib/tools/rename.ts";
import { errorText, runTool, whiteboardCatalog } from "../lib/tools/register.ts";

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

/**
 * `bb whiteboard tool [name] [json]`: list the catalog, or run one tool through
 * the same path agents use (design §3.5), like upstream `whiteboard api`.
 * A call from an agent thread carries its thread, so the session can open
 * there; outside a thread `desktopAvailable` is false.
 */
export function tool(ctx: WhiteboardContext) {
  return cliCommand({
    summary: "Run a Whiteboard agent tool",
    description:
      "With no name, list the Whiteboard tools. With a name, run it with a JSON argument.",
    positionals: [
      { name: "name", description: "Tool name, e.g. whiteboard_session_list" },
      { name: "json", description: "Tool input as a JSON object" },
    ],
    async run(input, cli): Promise<PluginCliResult> {
      const catalog = whiteboardCatalog(ctx.settings.scratchpadEnabled());
      const name = input.positionals.name;
      if (!name) {
        const width = Math.max(...catalog.map((entry) => entry.name.length));
        const lines = catalog.map(
          (entry) => `${entry.name.padEnd(width)}  ${entry.description.split("\n", 1)[0]}`,
        );
        return { exitCode: 0, stdout: capOutput(`${lines.join("\n")}\n`) };
      }
      const entry = catalog.find((candidate) => candidate.name === bbToolName(name));
      if (!entry) {
        return {
          exitCode: 1,
          stderr: `Unknown Whiteboard tool: ${name}. Run bb whiteboard tool to list them.\n`,
        };
      }
      let args;
      try {
        args = parseJsonText(input.positionals.json ?? "{}");
      } catch (error) {
        return { exitCode: 1, stderr: withNewline(errorText(error)) };
      }
      if (!isJsonObject(args))
        return { exitCode: 1, stderr: "Tool input must be a JSON object.\n" };
      const result = await runTool(ctx.engine, entry.tool, args, {
        threadId: cli.threadId,
        projectId: cli.projectId,
        signal: cli.signal,
      });
      const text = capOutput(withNewline(result.content[0].text));
      return result.isError ? { exitCode: 1, stderr: text } : { exitCode: 0, stdout: text };
    },
  });
}
