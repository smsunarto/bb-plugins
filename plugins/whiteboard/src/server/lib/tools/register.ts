import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import type {
  Engine,
  ThreadContextInput,
  WhiteboardSettings,
} from "../../../shared/contracts/engine.ts";
import type { JsonObject } from "../../../shared/vendor/json/src/index.ts";
import { whenSettingsLoaded } from "../settings.ts";
import {
  type AuthoringTool,
  toolResultText,
} from "../vendor/review/src/review-api/agent-client.ts";
import { authoringTools } from "../vendor/review/src/review-api/authoring-tools.ts";
import { callPublicTool, publicTool } from "../vendor/review/src/review-api/public-tools.ts";
import { flattenSchema } from "./flatten-schema.ts";
import { mcpAuthoringGuidance } from "./guidance.ts";
import { adaptWording, bbToolName, renameSchemaDescriptions, renameToolTokens } from "./rename.ts";

/** Trace storage needs the external CLI or hosted store, so trace stays off (design Q2). */
export const TRACE_ENABLED = false;

const INSTRUCTIONS_TOOL = "session_get_instructions";
const STATUS_TOOL = "whiteboard_status";

/** One catalog entry: the upstream public tool and what bb advertises for it. */
export type CatalogTool = {
  /** Upstream public tool (`session_x` or `whiteboard_status`); its HTTP mapping drives calls. */
  tool: AuthoringTool;
  /** The bb tool name. */
  name: string;
  description: string;
  parameters: JsonObject;
};

const catalogs = new Map<boolean, CatalogTool[]>();

/**
 * The published catalog, as upstream's MCP adapter lists it (`mcp.ts:99-131`):
 * `GET /authoring` (`http.ts:228-237`) served as JSON, `publicTool`, then
 * `session_get_instructions` and `whiteboard_status` first, and the
 * authoring guidance on `session_get_instructions` only.
 *
 * `/authoring` passes `scratchpadAvailable = desktopAvailable && scratchpadEnabled`
 * with `desktopAvailable = Boolean(open)`. The bb engine always supplies
 * `open`, so availability is the setting. The guidance hard-codes
 * `scratchpadAvailable: true`, as upstream does.
 */
export function whiteboardCatalog(scratchpadEnabled: boolean): CatalogTool[] {
  let catalog = catalogs.get(scratchpadEnabled);
  if (!catalog) catalogs.set(scratchpadEnabled, (catalog = buildCatalog(scratchpadEnabled)));
  return catalog;
}

function buildCatalog(scratchpadEnabled: boolean): CatalogTool[] {
  const published = (
    JSON.parse(JSON.stringify(authoringTools(scratchpadEnabled, TRACE_ENABLED))) as AuthoringTool[]
  ).map(publicTool);
  const first = [INSTRUCTIONS_TOOL, STATUS_TOOL].flatMap(
    (name) => published.find((tool) => tool.name === name) ?? [],
  );
  const ordered = [...first, ...published.filter((tool) => !first.includes(tool))];
  return ordered.map((tool) => ({
    tool,
    name: bbToolName(tool.name),
    description: adaptWording(
      renameToolTokens(
        tool.name === INSTRUCTIONS_TOOL
          ? `${mcpAuthoringGuidance({ scratchpadAvailable: true, traceEnabled: TRACE_ENABLED })}\n\n${tool.description}`
          : tool.description,
      ),
    ),
    parameters: renameSchemaDescriptions(flattenSchema(tool.inputSchema as JsonObject)),
  }));
}

/** Upstream `mcp.ts:212`: the bare message. Never throws, whatever was thrown. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Run one tool through upstream's adapter, exactly as the MCP server does
 * (`mcp.ts:183-216`), inside the caller's thread context. Every failure,
 * including one from the engine itself, becomes an `isError` result with
 * the bare message, so nothing throws out of a bb `execute` and bb never
 * wraps the text. Result text is upstream's, untouched.
 */
export async function runTool(
  engine: Engine,
  tool: AuthoringTool,
  params: unknown,
  context: ThreadContextInput,
): Promise<{ content: [{ type: "text"; text: string }]; isError?: true }> {
  try {
    return await engine.withThread(context, async () => {
      const input = isPlainObject(params) ? (params as Parameters<typeof callPublicTool>[2]) : {};
      const result = await callPublicTool(engine.client(), tool, input, context.signal);
      return { content: [{ type: "text", text: toolResultText(tool, result) }] };
    });
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: errorText(error) }] };
  }
}

/**
 * Register the upstream catalog as raw bb agent tools named
 * `whiteboard_session_*` and `whiteboard_status` (design §3.5). Raw JSON
 * schemas, so bb does not validate; upstream's routes validate with zod and
 * answer upstream's error text.
 *
 * Descriptions depend on the scratchpad setting, which loads asynchronously,
 * so registration waits for it. A change reloads the plugin (`settings.ts`).
 * The promise never rejects: a tool bb refuses is logged and the rest still
 * register.
 */
export async function registerTools(
  bb: BbPluginApi,
  engine: Engine,
  settings: WhiteboardSettings,
): Promise<void> {
  await whenSettingsLoaded(settings);
  for (const entry of whiteboardCatalog(settings.scratchpadEnabled())) {
    try {
      bb.agents.registerTool({
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
        execute: (params, ctx): Promise<PluginAgentToolResult> =>
          runTool(engine, entry.tool, params, {
            threadId: ctx.threadId,
            projectId: ctx.projectId,
            signal: ctx.signal,
          }),
      });
    } catch (error) {
      try {
        bb.log.error(`whiteboard: ${entry.name} was not registered: ${errorText(error)}`);
      } catch {
        // The plugin was disposed while registering; nothing is left to report to.
      }
    }
  }
}
