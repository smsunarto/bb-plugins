// U4 gate, round-trip half: `startToolProxy` binds a real loopback socket and
// the test acts as the MCP child, driving `handleMcpRequest` from the exact
// env block Amp would hand the spawned server.
import "./helpers/global-require.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AMP_BRIDGE_MCP_SERVER_NAME,
  handleMcpRequest,
  readChildEnvironment,
  startToolProxy,
  type McpChildEnvironment,
  type ProxiedToolCall,
  type StartToolProxyArgs,
  type ToolProxy,
} from "../src/bridge/tool-proxy.ts";

const TOOLS = [
  { name: "my_tool", description: "A bb tool", inputSchema: { type: "object" } },
  { name: "ask_user", description: "Asks the user", inputSchema: { type: "object" } },
];

const ENTRY_PATH = "/artifact/host.js";

function proxyArgs(overrides: Partial<StartToolProxyArgs> = {}): StartToolProxyArgs {
  return {
    tools: TOOLS,
    threadId: "thr_proxy_test",
    entryPath: ENTRY_PATH,
    callTool: () => Promise.resolve({ content: "" }),
    ...overrides,
  };
}

async function withProxy<T>(
  args: StartToolProxyArgs,
  fn: (proxy: ToolProxy) => Promise<T> | T,
): Promise<T> {
  const proxy = await startToolProxy(args);
  try {
    return await fn(proxy);
  } finally {
    proxy.close();
  }
}

function childSpec(proxy: ToolProxy): {
  command: string;
  args?: string[];
  env?: Record<string, string>;
} {
  const spec = proxy.config[AMP_BRIDGE_MCP_SERVER_NAME];
  assert.ok(spec !== undefined && "command" in spec, "expected a stdio MCP server spec");
  return spec;
}

function childEnvFor(proxy: ToolProxy): McpChildEnvironment {
  return readChildEnvironment(childSpec(proxy).env ?? {});
}

interface CapturedMcpMessage {
  id?: string | number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function makeChildWriter() {
  const writes: CapturedMcpMessage[] = [];
  return { writes, write: (message: unknown) => writes.push(message as CapturedMcpMessage) };
}

describe("bridge tool proxy (U4)", () => {
  it("mints a child spec that re-executes the artifact with --mcp-stdio", () =>
    withProxy(proxyArgs(), (proxy) => {
      const spec = childSpec(proxy);
      assert.equal(spec.command, process.execPath);
      assert.deepEqual(spec.args, [ENTRY_PATH, "--mcp-stdio"]);
      const env = spec.env ?? {};
      assert.match(env.BB_AMP_MCP_PORT ?? "", /^\d+$/u);
      assert.match(env.BB_AMP_MCP_TOKEN ?? "", /^[0-9a-f]{64}$/u);
      assert.deepEqual(JSON.parse(env.BB_AMP_MCP_TOOLS ?? ""), TOOLS);
      assert.deepEqual([...proxy.toolIds].sort(), [
        "mcp__bb-bridge__ask_user",
        "mcp__bb-bridge__my_tool",
      ]);
    }));

  it("digest tracks the tool set, not the socket", async () => {
    await withProxy(proxyArgs(), (first) =>
      withProxy(proxyArgs(), async (second) => {
        assert.equal(first.digest, second.digest);
        assert.notEqual(
          childSpec(first).env?.BB_AMP_MCP_PORT,
          childSpec(second).env?.BB_AMP_MCP_PORT,
        );
        await withProxy(proxyArgs({ tools: [...TOOLS].reverse() }), (reordered) => {
          assert.equal(first.digest, reordered.digest);
        });
        await withProxy(proxyArgs({ tools: TOOLS.slice(0, 1) }), (smaller) => {
          assert.notEqual(first.digest, smaller.digest);
        });
      }),
    );
  });

  it("round trips initialize, tools/list, and a tools/call to the bridge", async () => {
    const calls: ProxiedToolCall[] = [];
    await withProxy(
      proxyArgs({
        callTool: (call) => {
          calls.push(call);
          return Promise.resolve({ content: "hello from bb", isError: false });
        },
      }),
      async (proxy) => {
        const env = childEnvFor(proxy);
        const { writes, write } = makeChildWriter();

        await handleMcpRequest(
          env,
          { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
          write,
        );
        assert.deepEqual(writes[0]?.result?.serverInfo, {
          name: AMP_BRIDGE_MCP_SERVER_NAME,
          version: "1.0.0",
        });
        assert.equal(writes[0]?.result?.protocolVersion, "2025-06-18");

        await handleMcpRequest(env, { id: 2, method: "tools/list" }, write);
        const listed = writes[1]?.result?.tools;
        assert.ok(Array.isArray(listed));
        assert.deepEqual(
          listed.map((tool: { name: string }) => tool.name),
          ["my_tool", "ask_user"],
        );

        await handleMcpRequest(
          env,
          { id: 3, method: "tools/call", params: { name: "my_tool", arguments: { city: "Oslo" } } },
          write,
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.tool, "my_tool");
        assert.deepEqual(calls[0]?.arguments, { city: "Oslo" });
        assert.match(calls[0]?.callId ?? "", /^amp-mcp-my_tool-/u);
        assert.deepEqual(writes[2]?.result, {
          content: [{ type: "text", text: "hello from bb" }],
        });

        await handleMcpRequest(
          env,
          { id: 4, method: "tools/call", params: { name: "nope" } },
          write,
        );
        assert.equal(writes[3]?.error?.code, -32602);

        await handleMcpRequest(env, { id: 5, method: "prompts/list" }, write);
        assert.equal(writes[4]?.error?.code, -32601);
      },
    );
  });

  it("rejects a tampered token as an error result", () =>
    withProxy(proxyArgs(), async (proxy) => {
      const env: McpChildEnvironment = { ...childEnvFor(proxy), token: "deadbeef" };
      const { writes, write } = makeChildWriter();
      await handleMcpRequest(
        env,
        { id: 1, method: "tools/call", params: { name: "my_tool", arguments: {} } },
        write,
      );
      assert.equal(writes[0]?.result?.isError, true);
      assert.deepEqual(writes[0]?.result?.content, [
        { type: "text", text: "Invalid dynamic tool request" },
      ]);
    }));

  it("turns callTool failures and junk results into isError results", async () => {
    let junk = false;
    await withProxy(
      proxyArgs({
        callTool: () => (junk ? Promise.resolve(42) : Promise.reject(new Error("boom"))),
      }),
      async (proxy) => {
        const env = childEnvFor(proxy);
        const { writes, write } = makeChildWriter();

        await handleMcpRequest(
          env,
          { id: 1, method: "tools/call", params: { name: "my_tool", arguments: {} } },
          write,
        );
        assert.equal(writes[0]?.result?.isError, true);
        assert.deepEqual(writes[0]?.result?.content, [{ type: "text", text: "boom" }]);

        junk = true;
        await handleMcpRequest(
          env,
          { id: 2, method: "tools/call", params: { name: "my_tool", arguments: {} } },
          write,
        );
        assert.equal(writes[1]?.result?.isError, true);
        assert.deepEqual(writes[1]?.result?.content, [
          { type: "text", text: 'Tool "my_tool" returned an unrecognized result' },
        ]);
      },
    );
  });

  it("heartbeats notifications/progress while a call waits", async () => {
    await withProxy(
      proxyArgs({
        callTool: () =>
          new Promise((resolve) => setTimeout(() => resolve({ content: "done" }), 40)),
      }),
      async (proxy) => {
        const env: McpChildEnvironment = { ...childEnvFor(proxy), progressIntervalMs: 5 };
        const { writes, write } = makeChildWriter();
        await handleMcpRequest(
          env,
          {
            id: 1,
            method: "tools/call",
            params: { name: "my_tool", arguments: {}, _meta: { progressToken: "tok-1" } },
          },
          write,
        );
        const progress = writes.filter((message) => message.method === "notifications/progress");
        assert.ok(progress.length >= 1, "expected at least one progress notification");
        const last = writes.at(-1);
        assert.deepEqual(last?.result?.content, [{ type: "text", text: "done" }]);
      },
    );
  });
});
