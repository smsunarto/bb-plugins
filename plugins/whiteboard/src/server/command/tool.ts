import { cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import { errorMessage } from "../../shared/error-message.ts";
import { isJsonObject, parseJsonText } from "../../shared/json/index.ts";
import type { WhiteboardContext } from "../lib/context.ts";
import { toolRegistry } from "../tools/registry.ts";
import { capOutput } from "./cli-output.ts";

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

/**
 * `bb whiteboard tool [name] [json]`: list the tools, or run one through the
 * same `invoke` agents use. A call from an agent thread carries its thread,
 * so the session can open there; outside a thread `desktopAvailable` is false.
 */
export function tool(ctx: WhiteboardContext<"engine" | "settings">) {
  return cliCommand({
    summary: "Run a Whiteboard agent tool",
    description:
      "With no name, list the Whiteboard tools. With a name, run it with a JSON argument.",
    positionals: [
      { name: "name", description: "Tool name, e.g. whiteboard_session_list" },
      { name: "json", description: "Tool input as a JSON object" },
    ],
    async run(input, cli): Promise<PluginCliResult> {
      const registry = toolRegistry(ctx.engine, ctx.settings.scratchpadEnabled());
      const name = input.positionals.name;
      if (!name) {
        const width = Math.max(...registry.tools.map((entry) => entry.name.length));
        const lines = registry.tools.map(
          (entry) => `${entry.name.padEnd(width)}  ${entry.description.split("\n", 1)[0]}`,
        );
        return { exitCode: 0, stdout: capOutput(`${lines.join("\n")}\n`) };
      }
      if (!registry.tools.some((entry) => entry.name === name)) {
        return {
          exitCode: 1,
          stderr: `Unknown Whiteboard tool: ${name}. Run bb whiteboard tool to list them.\n`,
        };
      }
      let args;
      try {
        args = parseJsonText(input.positionals.json ?? "{}");
      } catch (error) {
        return { exitCode: 1, stderr: withNewline(errorMessage(error)) };
      }
      if (!isJsonObject(args))
        return { exitCode: 1, stderr: "Tool input must be a JSON object.\n" };
      const result = await registry.invoke(name, args, {
        threadId: cli.threadId,
        projectId: cli.projectId,
        signal: cli.signal,
      });
      const text = capOutput(withNewline(result.content[0].text));
      return result.isError ? { exitCode: 1, stderr: text } : { exitCode: 0, stdout: text };
    },
  });
}
