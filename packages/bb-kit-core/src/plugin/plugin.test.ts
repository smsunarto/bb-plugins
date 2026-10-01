import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import {
  definePlugin,
  type Context,
  type PluginErrorReporter,
  type PluginFailure,
  type PluginPerformanceReporter,
  type PluginTraceOutcome,
} from "./plugin.ts";
import { defineCommand, PluginCliError } from "../command/command.ts";
import { defineMutation, defineQuery } from "../rpc/rpc.ts";
import { defineTool } from "../tools/tools.ts";

const echo = defineQuery({
  input: z.object({ path: z.string() }).strict(),
  output: z.object({ path: z.string() }),
  execute: (_ctx, { path }) => ({ path }),
});

const ping = defineQuery({
  output: z.object({ pong: z.boolean() }),
  execute: () => ({ pong: true }),
});

type Counter = { next(): number };
type CounterContext = Context<{ counter: Counter }>;

const bump = defineMutation({
  output: z.object({ value: z.number() }),
  execute: (ctx: CounterContext) => ({ value: ctx.counter.next() }),
});

const status = defineCommand({
  summary: "Show status",
  async execute(ctx) {
    const result = await ping.execute(ctx);
    return { exitCode: 0, stdout: `pong=${result.pong} cwd=${ctx.cwd ?? ""}\n` };
  },
});

const cat = defineCommand({
  summary: "Print a path",
  positionals: [{ name: "path", description: "repo-relative path", required: true }],
  options: { upper: { type: "boolean", description: "uppercase the path" } },
  execute: (_ctx, { positionals, options }) => ({
    exitCode: 0,
    stdout: `${options.upper ? positionals.path.toUpperCase() : positionals.path}\n`,
  }),
});

function counter(): Counter {
  let value = 0;
  return { next: () => ++value };
}

function recordingReporter() {
  const failures: PluginFailure[] = [];
  const reporter: PluginErrorReporter = {
    capture(failure) {
      failures.push(failure);
      return undefined;
    },
  };
  return { failures, reporter };
}

function recordingTraces() {
  const traces: { operation: string; outcome?: PluginTraceOutcome }[] = [];
  const reporter: PluginPerformanceReporter = {
    start({ operation }) {
      const trace: (typeof traces)[number] = { operation };
      traces.push(trace);
      return {
        checkpoint() {},
        finish(outcome) {
          trace.outcome = outcome;
        },
      };
    },
  };
  return { traces, reporter };
}

async function load(plugin: (bb: BbPluginApi) => Promise<void>, pluginId = "demo") {
  const host = createFakePluginHost({ pluginId });
  await plugin(host.bb);
  return host;
}

// ── definition ──────────────────────────────────────────────────────

test("definePlugin returns the entry factory carrying the rpc map by identity", () => {
  const rpc = { echo, ping };
  const plugin = definePlugin({ pluginId: "demo", rpc });
  assert.equal(typeof plugin, "function");
  assert.equal(plugin.rpc, rpc);
});

test("definePlugin rejects invalid ids, RPC keys, command keys, and tool keys", () => {
  assert.throws(() => definePlugin({ pluginId: "Demo", rpc: {} }), /invalid plugin id "Demo"/);
  assert.throws(() => definePlugin({ pluginId: "demo", rpc: { "bad-key": ping } }), /bad-key/);
  assert.throws(() => definePlugin({ pluginId: "demo", rpc: { then: ping } }), /reserved RPC key/);
  assert.throws(
    () => definePlugin({ pluginId: "demo", rpc: {}, command: { rpc: status } }),
    /"rpc" is a reserved command name/,
  );
  const tool = defineTool({
    description: "t",
    parameters: z.object({}),
    execute: () => "ok",
  });
  assert.throws(
    () => definePlugin({ pluginId: "demo", rpc: {}, agents: { tools: { "Bad-Key": tool } } }),
    /invalid tool key "Bad-Key"/,
  );
});

test("a handler demanding a service the plugin does not provide is a type error", () => {
  // @ts-expect-error -- `bump` needs ctx.counter and there are no services.
  definePlugin({ pluginId: "demo", rpc: { bump } });
  definePlugin({ pluginId: "demo", rpc: { bump }, services: () => ({ counter: counter() }) });
});

// ── services and setup ──────────────────────────────────────────────

test("services build once per load and reach RPCs, commands, and setup", async () => {
  let builds = 0;
  let setupCount: number | undefined;
  const show = defineCommand({
    summary: "Show the counter",
    execute: (ctx: CounterContext) => ({ exitCode: 0, stdout: `${ctx.counter.next()}\n` }),
  });
  const { harness } = await load(
    definePlugin({
      pluginId: "demo",
      rpc: { bump },
      command: { show },
      services(bb) {
        assert.equal(bb.pluginId, "demo");
        builds += 1;
        return { counter: counter() };
      },
      setup(ctx) {
        setupCount = ctx.counter.next();
      },
    }),
  );
  assert.equal(setupCount, 1);
  assert.deepEqual(await harness.callRpc("bump"), { value: 2 });
  assert.equal((await harness.runCli(["show"])).stdout, "3\n");
  assert.equal(builds, 1);
});

test("setup receives a frozen context whose bb is the host", async () => {
  let seen: Context | undefined;
  const host = createFakePluginHost({ pluginId: "demo" });
  await definePlugin({
    pluginId: "demo",
    rpc: {},
    setup(ctx) {
      seen = ctx;
    },
  })(host.bb);
  assert.equal(seen?.bb, host.bb);
  assert.equal(Object.isFrozen(seen), true);
});

// ── RPC ─────────────────────────────────────────────────────────────

test("RPCs register under their map keys with host validation", async () => {
  const { harness } = await load(definePlugin({ pluginId: "demo", rpc: { echo, ping } }));
  assert.deepEqual(await harness.callRpc("echo", { path: "a" }), { path: "a" });
  assert.deepEqual(await harness.callRpc("ping"), { pong: true });
  await assert.rejects(harness.callRpc("echo", { path: 1 }));
  await assert.rejects(harness.callRpc("ping", { extra: true }));
});

test("an RPC failure is captured once and rethrown as-is", async () => {
  const { failures, reporter } = recordingReporter();
  const boom = new Error("boom");
  const fails = defineQuery({
    output: z.object({}),
    execute: () => {
      throw boom;
    },
  });
  const { harness } = await load(
    definePlugin({
      pluginId: "demo",
      rpc: { fails },
      errorReporter: () => reporter,
    }),
  );
  await assert.rejects(harness.callRpc("fails"), /boom/);
  assert.deepEqual(failures, [{ boundary: "rpc.execute", operation: "fails", error: boom }]);
});

test("rpcPublication.discoverable publishes descriptions to the host", async () => {
  const described = defineQuery({
    description: "Ping the plugin",
    output: z.object({ pong: z.boolean() }),
    execute: () => ({ pong: true }),
  });
  const { harness } = await load(
    definePlugin({
      pluginId: "demo",
      rpc: { described },
      rpcPublication: { discoverable: true, description: "Demo RPC" },
    }),
  );
  assert.deepEqual(
    harness.inspection.registrations.experimental_publishedRpcMethods.map(
      (method) => method.method,
    ),
    ["described"],
  );
});

// ── CLI ─────────────────────────────────────────────────────────────

test("commands parse argv with the SDK and get the invocation context", async () => {
  const { harness } = await load(
    definePlugin({ pluginId: "demo", rpc: { ping }, command: { status, cat } }),
  );
  assert.equal(
    (await harness.runCli(["status"], { cwd: "/work" })).stdout,
    "pong=true cwd=/work\n",
  );
  assert.equal((await harness.runCli(["cat", "a/b"])).stdout, "a/b\n");
  assert.equal((await harness.runCli(["cat", "a/b", "--upper"])).stdout, "A/B\n");
  const missing = await harness.runCli(["cat"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /missing required arguments: <path>/);
});

test("help lists curated commands, the rpc command, and every RPC method", async () => {
  const { harness } = await load(
    definePlugin({ pluginId: "demo", rpc: { echo }, command: { status } }),
  );
  const help = await harness.runCli(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /status/);
  assert.match(help.stdout, /rpc/);
  assert.match((await harness.runCli(["rpc", "--help"])).stdout, /echo/);
});

test("rpc command: JSON object in, compact JSON out, validated in-process", async () => {
  const { harness } = await load(
    definePlugin({ pluginId: "demo", rpc: { echo, ping, pingTwice: ping } }),
  );
  assert.deepEqual(await harness.runCli(["rpc", "echo", '{"path":"a"}']), {
    exitCode: 0,
    stdout: '{"path":"a"}\n',
    stderr: "",
  });
  assert.equal((await harness.runCli(["rpc", "ping"])).stdout, '{"pong":true}\n');
  assert.equal((await harness.runCli(["rpc", "pingTwice"])).stdout, '{"pong":true}\n');
  const unknown = await harness.runCli(["rpc", "nope"]);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /unknown RPC method "nope"/);
  for (const [input, message] of [
    ["{", /invalid JSON input/],
    ["[1]", /input must be a JSON object/],
    ['{"path":1}', /invalid input/],
  ] as const) {
    const result = await harness.runCli(["rpc", "echo", input]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, message);
  }
});

test("commands report unexpected failures, not PluginCliError or aborts", async () => {
  const { failures, reporter } = recordingReporter();
  const boom = new Error("boom");
  const aborted = new AbortController();
  aborted.abort();
  const fails = defineCommand({
    summary: "Fail",
    options: {
      mode: { type: "enum", values: ["usage", "crash"], description: "how", required: true },
    },
    execute: (ctx, { options }) => {
      if (options.mode === "usage") throw new PluginCliError("bad usage", { exitCode: 2 });
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      throw boom;
    },
  });
  const { harness } = await load(
    definePlugin({
      pluginId: "demo",
      rpc: {},
      command: { fails },
      errorReporter: () => reporter,
    }),
  );
  const usage = await harness.runCli(["fails", "--mode", "usage"]);
  assert.equal(usage.exitCode, 2);
  assert.match(usage.stderr, /bad usage/);
  assert.deepEqual(failures, []);

  assert.equal(
    (await harness.runCli(["fails", "--mode", "crash"], { signal: aborted.signal })).exitCode,
    1,
  );
  assert.deepEqual(failures, []);

  const crash = await harness.runCli(["fails", "--mode", "crash"]);
  assert.equal(crash.exitCode, 1);
  assert.deepEqual(failures, [{ boundary: "command.execute", operation: "fails", error: boom }]);
});

// ── agents ──────────────────────────────────────────────────────────

const greet = defineTool({
  description: "Greet someone",
  parameters: z.object({ name: z.string() }),
  execute: (ctx, { name }) => `hello ${name} from ${ctx.tool.threadId}`,
});

test("tools register under the plugin-prefixed name and get the tool context", async () => {
  const { harness } = await load(
    definePlugin({ pluginId: "demo-ns", rpc: {}, agents: { tools: { greet } } }),
  );
  assert.equal(
    await harness.callAgentTool("demo_ns_greet", { name: "ada" }, { threadId: "thr_1" }),
    "hello ada from thr_1",
  );
});

test("gated tools and skills resolve per session through configure", async () => {
  const gated = defineTool({
    description: "Only in project p",
    parameters: z.object({}),
    enabled: (_ctx, session) => session.project.id === "p",
    execute: () => "ok",
  });
  const host = createFakePluginHost({ pluginId: "demo", agentSkillIds: ["guide"] });
  await definePlugin({
    pluginId: "demo",
    rpc: {},
    agents: { tools: { greet, gated }, skills: ["guide"] },
  })(host.bb);
  const inProject = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ project: { id: "p" } }),
  );
  assert.deepEqual(
    inProject.tools.map((tool) => tool.name),
    ["demo_greet", "demo_gated"],
  );
  assert.deepEqual(inProject.skills, ["guide"]);
  const elsewhere = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ project: { id: "q" } }),
  );
  assert.deepEqual(
    elsewhere.tools.map((tool) => tool.name),
    ["demo_greet"],
  );
});

test("agents.instructions receives the plugin context", async () => {
  const host = createFakePluginHost({ pluginId: "demo" });
  await definePlugin({
    pluginId: "demo",
    rpc: {},
    services: () => ({ counter: counter() }),
    agents: {
      tools: {},
      instructions: (ctx, { threadId }) => `${threadId}:${ctx.counter.next()}`,
    },
  })(host.bb);
  const provider = host.harness.inspection.registrations.instructionProvider;
  assert.equal(provider?.({ threadId: "thr_9", projectId: "p" }), "thr_9:1");
});

test("tool failures are captured unless the call was aborted", async () => {
  const { failures, reporter } = recordingReporter();
  const boom = new Error("boom");
  const fails = defineTool({
    description: "Fail",
    parameters: z.object({}),
    execute: (ctx) => Promise.reject(ctx.tool.signal.aborted ? ctx.tool.signal.reason : boom),
  });
  const { harness } = await load(
    definePlugin({
      pluginId: "demo",
      rpc: {},
      agents: { tools: { fails } },
      errorReporter: () => reporter,
    }),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(harness.callAgentTool("demo_fails", {}, { signal: aborted.signal }));
  assert.deepEqual(failures, []);
  await assert.rejects(harness.callAgentTool("demo_fails", {}), /boom/);
  assert.deepEqual(failures, [{ boundary: "agent.tool", operation: "demo_fails", error: boom }]);
});

// ── load failures and reporters ─────────────────────────────────────

test("service and setup failures are captured at their boundary and rethrown", async () => {
  for (const [boundary, definition] of [
    [
      "plugin.factory",
      {
        services: () => {
          throw new Error("services");
        },
      },
    ],
    [
      "plugin.setup",
      {
        setup: () => {
          throw new Error("setup");
        },
      },
    ],
  ] as const) {
    const { failures, reporter } = recordingReporter();
    const host = createFakePluginHost({ pluginId: "demo" });
    await assert.rejects(
      definePlugin({ pluginId: "demo", rpc: {}, errorReporter: () => reporter, ...definition })(
        host.bb,
      ),
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.boundary, boundary);
  }
});

test("a throwing reporter factory or capture never breaks the plugin", async () => {
  const { harness } = await load(
    definePlugin({
      pluginId: "demo",
      rpc: { ping },
      errorReporter: () => {
        throw new Error("factory");
      },
    }),
  );
  assert.deepEqual(await harness.callRpc("ping"), { pong: true });

  const throwing: PluginErrorReporter = {
    capture() {
      throw new Error("capture");
    },
  };
  const fails = defineQuery({
    output: z.object({}),
    execute: () => {
      throw new Error("original");
    },
  });
  const second = await load(
    definePlugin({ pluginId: "demo", rpc: { fails }, errorReporter: () => throwing }),
  );
  await assert.rejects(second.harness.callRpc("fails"), /original/);
});

test("reporters dispose with the plugin", async () => {
  const disposed: number[] = [];
  const host = createFakePluginHost({ pluginId: "demo" });
  await definePlugin({
    pluginId: "demo",
    rpc: {},
    errorReporter: () => ({
      capture: () => undefined,
      dispose: (timeoutMs) => {
        disposed.push(timeoutMs);
      },
    }),
  })(host.bb);
  await host.harness.lifecycle.dispose();
  assert.equal(disposed.length, 1);
});

test("a host that refuses onDispose disables reporting without failing the load", async () => {
  const { failures, reporter } = recordingReporter();
  const host = createFakePluginHost({ pluginId: "demo" });
  const refusing = Object.create(host.bb, {
    onDispose: {
      value: () => {
        throw new Error("no dispose");
      },
    },
  }) as BbPluginApi;
  const fails = defineQuery({
    output: z.object({}),
    execute: () => {
      throw new Error("x");
    },
  });
  await definePlugin({ pluginId: "demo", rpc: { fails }, errorReporter: () => reporter })(refusing);
  await assert.rejects(host.harness.callRpc("fails"));
  assert.deepEqual(failures, []);
});

test("startup, RPC, and tool calls are traced with their outcomes", async () => {
  const { traces, reporter } = recordingTraces();
  const fails = defineQuery({
    output: z.object({}),
    execute: () => {
      throw new Error("x");
    },
  });
  const { harness } = await load(
    definePlugin({
      pluginId: "demo",
      rpc: { ping, fails },
      agents: { tools: { greet } },
      performanceReporter: () => reporter,
    }),
  );
  await harness.callRpc("ping");
  await assert.rejects(harness.callRpc("fails"));
  await harness.callAgentTool("demo_greet", { name: "a" });
  assert.deepEqual(
    traces.map(({ operation, outcome }) => [operation, outcome]),
    [
      ["plugin.startup", "ok"],
      ["rpc.ping", "ok"],
      ["rpc.fails", "error"],
      ["tool.greet", "ok"],
    ],
  );
});
