/**
 * `src/bridge/tool-proxy.ts` — bb dynamic tools as an MCP server for the Amp
 * child.
 *
 * Two halves of one wire:
 *
 * - `startToolProxy` runs in the bridge process. It listens on a loopback TCP
 *   socket, mints a one-time token, and returns the Amp `mcpConfig` entry
 *   that re-executes this plugin's artifact with `--mcp-stdio` as the MCP
 *   server child. Tool calls arriving over the socket are forwarded to the
 *   `callTool` callback (the session wires it to the runtime's
 *   `item/tool/call` tracker) and the result is written back as one JSON
 *   line.
 * - `runMcpStdioChild` runs in that re-executed child. It speaks MCP over
 *   stdio to Amp (`initialize`, `tools/list`, `tools/call`) and proxies each
 *   call over the socket. A pending call heartbeats `notifications/progress`
 *   every 15s so MCP clients do not time out a tool that waits on a human.
 *
 * The pattern is lifted from bb's own ACP dynamic-tool proxy; the wire
 * response schema is restated locally because the SDK exports
 * `buildBridgeToolCallContent` but not the `BridgeToolCallResult` type.
 *
 * The session asks the proxy for a tool-set digest and never talks to it
 * again: the digest feeds `SessionShape.mcpConfigDigest`, so a changed bb
 * tool set restarts the Amp CLI ("tools apply at next turn" semantics).
 */

import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { MCPConfig } from "./execute.ts";
import {
  dynamicToolSchema,
  experimental_buildBridgeToolCallContent as buildBridgeToolCallContent,
  type DynamicTool,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

/** The MCP server name Amp sees. `shapes.ts` maps tools of this server (and
 *  the `mcp__bb-bridge__*` tool ids Amp derives from it) to `server: "bb"`. */
export const AMP_BRIDGE_MCP_SERVER_NAME = "bb-bridge";

const ENV_PORT = "BB_AMP_MCP_PORT";
const ENV_TOKEN = "BB_AMP_MCP_TOKEN";
const ENV_TOOLS = "BB_AMP_MCP_TOOLS";
/** Test-only override for the progress heartbeat interval (milliseconds). */
const ENV_PROGRESS_INTERVAL_MS = "BB_AMP_MCP_PROGRESS_INTERVAL_MS";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Interval between `notifications/progress` messages for a pending
 * tools/call. MCP clients fail a request after 60 seconds unless a progress
 * notification for its `progressToken` resets the timer, and a bb tool such
 * as AskUserQuestion waits on the user for minutes.
 */
const TOOL_CALL_PROGRESS_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// The wire between the bridge's socket and the MCP child: one JSON line per
// request, one JSON line per response.
// ---------------------------------------------------------------------------

const proxyRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initialized"),
    token: z.string(),
    toolCount: z.number(),
  }),
  z.object({
    kind: z.literal("toolCall"),
    token: z.string(),
    callId: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
]);
type ProxyRequest = z.infer<typeof proxyRequestSchema>;

const toolCallContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]);

/** The bridge side answers with the runtime's tool-call result fields plus an
 *  `ok` discriminant; `images` defaults to `[]` so text-only results parse. */
const proxyResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    content: z.string(),
    contentBlocks: z.array(toolCallContentBlockSchema).optional(),
    images: z.array(z.object({ data: z.string(), mimeType: z.string() })).default([]),
    isError: z.boolean().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type ProxyResponse = z.infer<typeof proxyResponseSchema>;

/** What `callTool` is expected to resolve with (the runtime tracker's
 *  `BridgeToolCallResult`, which the SDK does not export as a type). A
 *  payload that does not parse becomes an error result, never garbage on the
 *  wire. */
const toolCallResultSchema = z.object({
  content: z.string(),
  contentBlocks: z.array(toolCallContentBlockSchema).optional(),
  images: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
  isError: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Bridge side: startToolProxy
// ---------------------------------------------------------------------------

/** One forwarded tool call, in the vocabulary `item/tool/call` wants. */
export interface ProxiedToolCall {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolProxy {
  /** The Amp execute-option `mcpConfig` entry for this proxy. */
  readonly config: MCPConfig;
  /** sha256 of the canonical tool list. Feeds `SessionShape.mcpConfigDigest`:
   *  same tools, same digest — the socket's port and token stay out of it so
   *  an unchanged tool set never restarts the CLI. */
  readonly digest: string;
  /** Amp-visible tool ids (`mcp__bb-bridge__<name>`), for
   *  `ProjectionContext.bbToolIds`. */
  readonly toolIds: ReadonlySet<string>;
  close(): void;
}

export interface StartToolProxyArgs {
  tools: readonly DynamicTool[];
  /** For log lines only; the socket is authenticated by the token. */
  threadId: string;
  /** The artifact the MCP child re-executes with `--mcp-stdio`. The entry
   *  point owns this path (bundled artifact vs source run); this module
   *  cannot derive it safely from its own location. */
  entryPath: string;
  callTool: (call: ProxiedToolCall) => Promise<unknown>;
}

export function startToolProxy(args: StartToolProxyArgs): Promise<ToolProxy> {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    handleProxySocket(socket, token, args);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Amp dynamic tool proxy did not bind a TCP port"));
        return;
      }
      resolve({
        config: {
          [AMP_BRIDGE_MCP_SERVER_NAME]: {
            command: process.execPath,
            args: [args.entryPath, "--mcp-stdio"],
            env: {
              [ENV_PORT]: String(address.port),
              [ENV_TOKEN]: token,
              [ENV_TOOLS]: JSON.stringify(args.tools),
            },
          },
        },
        digest: toolSetDigest(args.tools),
        toolIds: new Set(
          args.tools.map((tool) => `mcp__${AMP_BRIDGE_MCP_SERVER_NAME}__${tool.name}`),
        ),
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

function handleProxySocket(socket: Socket, token: string, args: StartToolProxyArgs): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) return;
    const line = buffer.slice(0, newlineIndex);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      endWith(socket, { ok: false, error: "Invalid JSON" });
      return;
    }
    const request = proxyRequestSchema.safeParse(parsed);
    if (!request.success || request.data.token !== token) {
      endWith(socket, { ok: false, error: "Invalid dynamic tool request" });
      return;
    }
    if (request.data.kind === "initialized") {
      process.stderr.write(
        `amp bridge: "${AMP_BRIDGE_MCP_SERVER_NAME}" answered initialize for thread "${args.threadId}" (${request.data.toolCount} tools)\n`,
      );
      endWith(socket, { ok: true, content: "", images: [] });
      return;
    }
    void forwardToolCall(request.data, args).then((response) => endWith(socket, response));
  });
}

async function forwardToolCall(
  request: Extract<ProxyRequest, { kind: "toolCall" }>,
  args: StartToolProxyArgs,
): Promise<ProxyResponse> {
  let raw: unknown;
  try {
    raw = await args.callTool({
      callId: request.callId,
      tool: request.tool,
      arguments: request.arguments,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = toolCallResultSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: `Tool "${request.tool}" returned an unrecognized result` };
  }
  return { ok: true, images: [], ...result.data };
}

function endWith(socket: Socket, response: ProxyResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function toolSetDigest(tools: readonly DynamicTool[]): string {
  const canonical = [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? null,
      presentation: tool.presentation ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ---------------------------------------------------------------------------
// Child side: the MCP stdio server Amp spawns
// ---------------------------------------------------------------------------

export interface McpChildEnvironment {
  port: number;
  token: string;
  tools: DynamicTool[];
  progressIntervalMs: number | undefined;
}

/** Reads the child's configuration from the env block `startToolProxy` wrote
 *  into the MCP server spec. Exported so a test can drive `handleMcpRequest`
 *  against a live proxy from the exact variables Amp would pass. */
export function readChildEnvironment(env: Record<string, string | undefined>): McpChildEnvironment {
  const port = Number(env[ENV_PORT]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${ENV_PORT} must be a positive integer`);
  }
  const token = env[ENV_TOKEN];
  const toolsJson = env[ENV_TOOLS];
  if (token === undefined || toolsJson === undefined) {
    throw new Error("Missing Amp dynamic tool MCP server environment");
  }
  const tools = dynamicToolSchema.array().parse(JSON.parse(toolsJson));
  const rawInterval = env[ENV_PROGRESS_INTERVAL_MS];
  const progressIntervalMs =
    rawInterval !== undefined && Number(rawInterval) > 0 ? Number(rawInterval) : undefined;
  return { port, token, tools, progressIntervalMs };
}

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
}

let nextMcpToolCallId = 0;

function mcpToolCallId(toolName: string): string {
  nextMcpToolCallId += 1;
  return `amp-mcp-${toolName}-${Date.now()}-${nextMcpToolCallId}`;
}

function callBridge(
  env: McpChildEnvironment,
  request: { kind: "initialized"; toolCount: number } | (ProxiedToolCall & { kind: "toolCall" }),
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port: env.port });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ...request, token: env.token })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      socket.end();
      try {
        resolve(proxyResponseSchema.parse(JSON.parse(line)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!buffer.includes("\n")) {
        reject(new Error("Amp dynamic tool proxy closed without a response"));
      }
    });
  });
}

function objectParams(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

/** The `_meta.progressToken` of a request, when the client asked for one. */
function readProgressToken(params: unknown): string | number | null {
  const meta = objectParams(objectParams(params)._meta).progressToken;
  return typeof meta === "string" || typeof meta === "number" ? meta : null;
}

/**
 * Sends `notifications/progress` for `progressToken` every `intervalMs`
 * until the returned stop function runs. Progress is a counter: the MCP spec
 * only requires it to increase, and the total is unknown while a user types.
 */
function startProgressHeartbeat(args: {
  intervalMs: number | undefined;
  progressToken: string | number;
  write: (message: unknown) => void;
}): () => void {
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    args.write({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: args.progressToken, progress },
    });
  }, args.intervalMs ?? TOOL_CALL_PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * One MCP request from Amp, answered through `write`. Exported (with
 * `readChildEnvironment`) as the child's test seam: the stdio pump below is
 * the only part a test cannot drive in-process.
 *
 * Unknown method → -32601. A dropped reply hangs Amp's request forever,
 * which is worse than any error.
 */
export async function handleMcpRequest(
  env: McpChildEnvironment,
  message: JsonRpcMessage,
  write: (message: unknown) => void,
): Promise<void> {
  if (message.id === undefined || message.method === undefined) return;
  const writeResult = (result: unknown): void => {
    write({ jsonrpc: "2.0", id: message.id, result });
  };

  switch (message.method) {
    case "initialize": {
      const requested = objectParams(message.params).protocolVersion;
      writeResult({
        protocolVersion: typeof requested === "string" ? requested : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: AMP_BRIDGE_MCP_SERVER_NAME, version: "1.0.0" },
      });
      void callBridge(env, { kind: "initialized", toolCount: env.tools.length }).catch(
        (error: unknown) => {
          process.stderr.write(
            `bb-bridge MCP: failed to report initialize: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        },
      );
      return;
    }

    case "tools/list":
      writeResult({
        tools: env.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;

    case "tools/call": {
      const params = objectParams(message.params);
      const name = typeof params.name === "string" ? params.name : "";
      const tool = env.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        });
        return;
      }
      const rawArguments = objectParams(params.arguments);
      const progressToken = readProgressToken(message.params);
      const stopHeartbeat =
        progressToken === null
          ? () => {}
          : startProgressHeartbeat({
              intervalMs: env.progressIntervalMs,
              progressToken,
              write,
            });
      try {
        const result = await callBridge(env, {
          kind: "toolCall",
          callId: mcpToolCallId(tool.name),
          tool: tool.name,
          arguments: rawArguments,
        });
        stopHeartbeat();
        if (!result.ok) {
          writeResult({ content: [{ type: "text", text: result.error }], isError: true });
          return;
        }
        writeResult({
          content: buildBridgeToolCallContent(result),
          ...(result.isError === true ? { isError: true } : {}),
        });
      } catch (error) {
        stopHeartbeat();
        writeResult({
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
      return;
    }

    default:
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported MCP method: ${message.method}` },
      });
  }
}

/**
 * The `--mcp-stdio` re-entry. The plugin's entry point calls this before any
 * bridge state exists when the artifact was spawned as Amp's MCP server; it
 * never returns to bridge code.
 */
export function runMcpStdioChild(): void {
  const env = readChildEnvironment(process.env);
  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    void handleMcpRequest(env, message, write);
  });
}
