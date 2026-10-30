import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import type {
  Engine,
  ThreadContextInput,
  WhiteboardSettings,
} from "../../shared/contracts/engine.ts";
import { errorMessage } from "../../shared/error-message.ts";
import { toolErrorText } from "../lib/boundary-errors.ts";
import { whenSettingsLoaded } from "../lib/settings.ts";
import { whiteboardTools } from "./catalog.ts";

export type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };

const failure = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

/**
 * The tools as bb registers them and `bb whiteboard tool` runs them. `invoke`
 * checks the input against the tool's schema, then runs the tool inside the
 * engine as the caller. It never throws: every failure answers `isError`
 * with the boundary's message.
 */
export function toolRegistry(engine: Pick<Engine, "api" | "run">, scratchpadEnabled: boolean) {
  const tools = whiteboardTools(scratchpadEnabled);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Tool boundary: the tool's schema parses `raw` first.
    async invoke(name: string, raw: unknown, context: ThreadContextInput): Promise<ToolResult> {
      const tool = byName.get(name);
      if (!tool) return failure(`Unknown Whiteboard tool: ${name}.`);
      const input = tool.schema.safeParse(raw);
      if (!input.success) return failure(toolErrorText(name, input.error));
      try {
        const text = await engine.run(context, (signal) =>
          tool.execute(engine.api, input.data, signal),
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return failure(toolErrorText(name, error));
      }
    },
  };
}

/**
 * Register every tool with bb. Zod schemas go to bb as they are; a recursive
 * one goes as its flattened JSON Schema. Either way each call runs through
 * `invoke`. Descriptions depend on the scratchpad setting, which loads
 * asynchronously, so registration waits for it. The promise never rejects: a
 * tool bb refuses is logged and the rest still register.
 */
export async function registerTools(
  bb: BbPluginApi,
  engine: Engine,
  settings: WhiteboardSettings,
): Promise<void> {
  await whenSettingsLoaded(settings);
  const registry = toolRegistry(engine, settings.scratchpadEnabled());
  for (const tool of registry.tools) {
    const execute = (params: unknown, ctx: PluginAgentToolContext) =>
      registry.invoke(tool.name, params, {
        threadId: ctx.threadId,
        projectId: ctx.projectId,
        signal: ctx.signal,
      });
    try {
      if (tool.advertised)
        bb.agents.registerTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.advertised,
          execute,
        });
      else
        bb.agents.registerTool({
          name: tool.name,
          description: tool.description,
          // The SDK's typings name its own zod (4.6); these schemas are this
          // plugin's zod 4.4. bb calls only safeParse and toJSONSchema on them,
          // which both versions provide.
          parameters: tool.schema as never,
          execute,
        });
    } catch (error) {
      try {
        bb.log.error(`whiteboard: ${tool.name} was not registered: ${errorMessage(error)}`);
      } catch {
        // The plugin was disposed while registering; nothing is left to report to.
      }
    }
  }
}
