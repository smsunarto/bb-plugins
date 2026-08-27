import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { definePlugin, type Context } from "./plugin.ts";
import { defineCommand } from "../cli/cli.ts";
import { defineMutation, defineQuery, noInputSchema } from "../rpc/rpc.ts";
import { defineTool, type Session, type ToolContext } from "../tools/tools.ts";
import type { HostSeam } from "./host.ts";

const echo = defineQuery({
  input: z.object({ path: z.string() }),
  output: z.object({ path: z.string() }),
  execute(_ctx, { path }) {
    return { path };
  },
});

const ping = defineQuery({
  output: z.object({ pong: z.boolean() }),
  execute() {
    return { pong: true };
  },
});

const readURL = defineMutation({
  input: z.object({ url: z.string() }),
  output: z.object({ ok: z.boolean() }),
  execute() {
    return { ok: true };
  },
});

const demo = { echo, ping, readURL };

const status = defineCommand({
  summary: "Show status",
  async execute(ctx) {
    const result = await ping.execute(ctx);
    return { exitCode: 0, stdout: `pong=${result.pong} cwd=${ctx.cwd ?? ""}\n` };
  },
});

type RPCArgs = {
  contract: Parameters<HostSeam["rpc"]["register"]>[0];
  handlers: Parameters<HostSeam["rpc"]["register"]>[1];
};
type CLIRegistration = Parameters<HostSeam["cli"]["register"]>[0];
type ToolRegistration = Parameters<HostSeam["agents"]["registerTool"]>[0];
type ConfigureProvider = Parameters<HostSeam["agents"]["configure"]>[0];
type InstructionsProvider = Parameters<HostSeam["agents"]["contributeInstructions"]>[0];

function fakeHost() {
  const captured: {
    order: string[];
    rpc?: RPCArgs;
    cli?: CLIRegistration;
    agentTools: ToolRegistration[];
    configure?: ConfigureProvider;
    instructions?: InstructionsProvider;
  } = { order: [], agentTools: [] };
  const bb: HostSeam & { sdk: { tag: string }; storage: { kv: object } } = {
    rpc: {
      register(contract, handlers) {
        captured.order.push("rpc");
        captured.rpc = { contract, handlers };
      },
    },
    cli: {
      register(registration) {
        captured.order.push("cli");
        captured.cli = registration;
      },
    },
    agents: {
      registerTool(registration) {
        captured.order.push("agents");
        captured.agentTools.push(registration);
      },
      configure(provider) {
        captured.configure = provider;
      },
      contributeInstructions(provider) {
        captured.instructions = provider;
      },
    },
    sdk: { tag: "sdk" },
    storage: { kv: {} },
  };
  return { bb: bb as unknown as BbPluginApi, captured };
}

async function loadPlugin() {
  const { bb, captured } = fakeHost();
  const plugin = definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    cli: { status },
    setup() {
      captured.order.push("setup");
    },
  });
  await plugin(bb);
  return { bb, captured };
}

test("registration order: rpc, cli, then setup", async () => {
  const { captured } = await loadPlugin();
  assert.deepEqual(captured.order, ["rpc", "cli", "setup"]);
});

test("contract uses public names; no-input RPCs get the vendored schema", async () => {
  const { captured } = await loadPlugin();
  const contract = captured.rpc?.contract ?? {};
  assert.deepEqual(Object.keys(contract).sort(), ["echo", "ping", "readURL"]);
  assert.equal(contract.ping?.input, noInputSchema);
  assert.notEqual(contract.echo?.input, noInputSchema);
});

test("wire handlers invoke the procedure directly with the context (no re-validation)", async () => {
  const { captured } = await loadPlugin();
  const handlers = captured.rpc?.handlers ?? {};
  assert.deepEqual(await handlers.echo?.({ path: "x" }), { path: "x" });
  assert.deepEqual(await handlers.ping?.(null), { pong: true });
});

test("cli registration: plugin id as name, summary, metadata for every command", async () => {
  const { captured } = await loadPlugin();
  assert.equal(captured.cli?.name, "demo-ns");
  assert.equal(captured.cli?.summary, "CLI for the demo-ns plugin");
  const commands = captured.cli?.commands ?? [];
  const byName = new Map(commands.map((command) => [command.name, command]));
  assert.deepEqual([...byName.keys()].sort(), ["rpc", "status"]);
  assert.equal(byName.get("status")?.summary, "Show status");
  assert.equal(byName.get("rpc")?.summary, "Call an RPC (JSON object in, JSON object out)");
  assert.equal(typeof byName.get("status")?.usage, "string");
});

test("omitted cli: default summary, only the rpc subtree", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({ pluginId: "demo-ns", rpc: demo })(bb);
  assert.equal(captured.cli?.summary, "CLI for the demo-ns plugin");
  assert.deepEqual(
    (captured.cli?.commands ?? []).map((command) => command.name),
    ["rpc"],
  );
});

test("setup receives the host", async () => {
  const { bb } = fakeHost();
  let setupBb: BbPluginApi | undefined;
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    setup(received) {
      setupBb = received;
    },
  })(bb);
  assert.equal(setupBb, bb);
});

test("definePlugin return is callable and carries the rpc map by identity", async () => {
  const { bb } = fakeHost();
  const plugin = definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
  });
  assert.equal(plugin.rpc, demo);
  await plugin(bb);
});

test("definePlugin rejects an invalid id", () => {
  assert.throws(() => definePlugin({ pluginId: "Bad", rpc: demo }), /invalid plugin id "Bad"/);
  assert.throws(() => definePlugin({ pluginId: "-x", rpc: demo }), /invalid plugin id/);
});

test("definePlugin rejects an invalid RPC key", () => {
  assert.throws(
    () =>
      definePlugin({
        pluginId: "demo-ns",
        rpc: { ReadFile: ping },
      }),
    /invalid RPC key "ReadFile"/,
  );
});

test("reserved command names throw at define time", () => {
  const loose = defineCommand({ summary: "x", execute: () => ({ exitCode: 0 }) });
  for (const key of ["rpc", "help"]) {
    assert.throws(
      () =>
        definePlugin({
          pluginId: "demo-ns",
          rpc: demo,
          cli: { [key]: loose },
        }),
      new RegExp(`"${key}" is a reserved command name`),
    );
  }
});

// ---- the run dispatcher ---------------------------------------------

async function dispatcher() {
  const { captured } = await loadPlugin();
  const registration = captured.cli;
  assert.ok(registration);
  return registration;
}

test("curated command runs with the plugin context and the invocation context", async () => {
  const cli = await dispatcher();
  assert.deepEqual(await cli.run(["status"], { cwd: "/w" }), {
    exitCode: 0,
    stdout: "pong=true cwd=/w\n",
  });
});

test("rpc subtree: with-input happy path prints compact JSON", async () => {
  const cli = await dispatcher();
  assert.deepEqual(await cli.run(["rpc", "echo", '{"path":"a"}'], {}), {
    exitCode: 0,
    stdout: '{"path":"a"}\n',
  });
});

test("rpc subtree: names match the public RPC name", async () => {
  const cli = await dispatcher();
  assert.deepEqual(await cli.run(["rpc", "readURL", '{"url":"u"}'], {}), {
    exitCode: 0,
    stdout: '{"ok":true}\n',
  });
});

test("rpc subtree: no-input procedure runs without an argument", async () => {
  const cli = await dispatcher();
  assert.deepEqual(await cli.run(["rpc", "ping"], {}), {
    exitCode: 0,
    stdout: '{"pong":true}\n',
  });
});

test("rpc subtree: malformed JSON is exit 1", async () => {
  const cli = await dispatcher();
  const result = await cli.run(["rpc", "echo", "{bad"], {});
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /^invalid JSON input: /);
});

test("rpc subtree: non-object JSON is exit 1", async () => {
  const cli = await dispatcher();
  for (const raw of ["5", "null", '"x"', "[1]"]) {
    const result = await cli.run(["rpc", "echo", raw], {});
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "input must be a JSON object\n");
  }
});

test("rpc subtree: client validation failures are exit 1 on stderr", async () => {
  const cli = await dispatcher();
  const missing = await cli.run(["rpc", "echo"], {});
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr ?? "", /invalid input/);
  const extra = await cli.run(["rpc", "ping", "{}"], {});
  assert.equal(extra.exitCode, 1);
  assert.match(extra.stderr ?? "", /takes no input/);
});

test("root help lists curated commands and the rpc subtree", async () => {
  const cli = await dispatcher();
  const result = await cli.run(["--help"], {});
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /Usage: demo-ns/);
  assert.match(result.stdout ?? "", /status/);
  assert.match(result.stdout ?? "", /rpc/);
});

test("rpc --help lists procedures with their kinds", async () => {
  const cli = await dispatcher();
  const result = await cli.run(["rpc", "--help"], {});
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /echo/);
  assert.match(result.stdout ?? "", /readURL/);
  assert.match(result.stdout ?? "", /\(query\)/);
  assert.match(result.stdout ?? "", /\(mutation\)/);
});

test("empty argv is exit 2 with help; help command is exit 0", async () => {
  const cli = await dispatcher();
  const empty = await cli.run([], {});
  assert.equal(empty.exitCode, 2);
  assert.match(empty.stderr ?? "", /Usage: demo-ns/);
  const help = await cli.run(["help"], {});
  assert.equal(help.exitCode, 0);
});

// ---- agent tools ----------------------------------------------------

let toolGate = true;
const seenToolContexts: unknown[] = [];

const notifyUser = defineTool({
  description: "Post a notification",
  parameters: z.object({ message: z.string() }),
  enabled: () => toolGate,
  execute(ctx: ToolContext<Context>, input) {
    seenToolContexts.push(ctx);
    return `sent:${input.message}`;
  },
});

const inventory = defineTool({
  description: "List things",
  parameters: z.object({}),
  execute: () => "listed",
});

test("agent tools register under the derived public name", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: { tools: { user: notifyUser, inventory } },
  })(bb);
  assert.deepEqual(
    captured.agentTools.map((tool) => tool.name),
    ["demo_ns_user", "demo_ns_inventory"],
  );
  assert.equal(captured.agentTools[0]?.description, "Post a notification");
  assert.equal(captured.agentTools[0]?.parameters, notifyUser.parameters);
});

test("factory order: rpc, cli, agents, then setup", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    cli: { status },
    agents: { tools: { inventory } },
    setup() {
      captured.order.push("setup");
    },
  })(bb);
  assert.deepEqual(captured.order, ["rpc", "cli", "agents", "setup"]);
});

test("registered execute freezes the overlay context and returns the tool result", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: { tools: { user: notifyUser } },
  })(bb);
  const registration = captured.agentTools[0];
  assert.ok(registration);
  const signal = new AbortController().signal;
  seenToolContexts.length = 0;
  const result = await registration.execute(
    { message: "hi" },
    { threadId: "t1", projectId: "p1", signal },
  );
  assert.equal(result, "sent:hi");
  const ctx = seenToolContexts[0] as {
    bb: unknown;
    tool: { threadId: string; projectId: string; signal: AbortSignal };
  };
  assert.equal(ctx.bb, bb);
  assert.deepEqual(ctx.tool, { threadId: "t1", projectId: "p1", signal });
  assert.equal(Object.isFrozen(ctx), true);
});

test("a gated tool synthesizes one configure listing derived names for passing predicates", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: { tools: { user: notifyUser, inventory } },
  })(bb);
  const provider = captured.configure;
  assert.ok(provider);
  const session = {} as Session;
  toolGate = true;
  assert.deepEqual(provider(session), {
    tools: ["demo_ns_user", "demo_ns_inventory"],
    skills: [],
  });
  toolGate = false;
  assert.deepEqual(provider(session), { tools: ["demo_ns_inventory"], skills: [] });
  toolGate = true;
});

test("agents.skills: a static array passes through; a selector runs per resolution", async () => {
  const fixed = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: { tools: { inventory }, skills: ["triage"] },
  })(fixed.bb);
  assert.deepEqual(fixed.captured.configure?.({} as Session), {
    tools: ["demo_ns_inventory"],
    skills: ["triage"],
  });
  const selected = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: { tools: { inventory }, skills: () => ["a", "b"] },
  })(selected.bb);
  assert.deepEqual(selected.captured.configure?.({} as Session), {
    tools: ["demo_ns_inventory"],
    skills: ["a", "b"],
  });
});

test("ungated, skill-less tools register no configure and no instructions", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: { tools: { inventory } },
  })(bb);
  assert.equal(captured.configure, undefined);
  assert.equal(captured.instructions, undefined);
});

test("agents.instructions wires contributeInstructions with the plugin context", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: {
      tools: { inventory },
      instructions(ctx, resolution) {
        return ctx.bb ? `${resolution.threadId}/${resolution.projectId}` : null;
      },
    },
  })(bb);
  assert.equal(captured.instructions?.({ threadId: "t", projectId: "p" }), "t/p");
});

test("invalid tool keys throw at define time", () => {
  assert.throws(
    () =>
      definePlugin({
        pluginId: "demo-ns",
        rpc: demo,
        agents: { tools: { "Bad-Key": inventory } },
      }),
    /invalid tool key "Bad-Key"/,
  );
});

// ---- type-level pins ------------------------------------------------

function typeOnly() {
  defineCommand({
    summary: "wants more than the preset provides",
    // @ts-expect-error a command demanding a field outside CommandContext is rejected
    execute: (_ctx: { extra(): void }) => ({ exitCode: 0 }),
  });
  const usesHostFields = defineCommand({
    summary: "reads cwd from CommandContext",
    execute(ctx) {
      return {
        exitCode: 0,
        stdout: ctx.cwd ?? "",
      };
    },
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    cli: { usesHostFields },
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    // @ts-expect-error leftover wrapper { summary, commands } is a type error
    cli: { summary: "x", commands: { status } },
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    // @ts-expect-error reserved key rpc is a type error
    cli: { rpc: status },
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    // @ts-expect-error authors cannot supply a context factory
    ctx: () => ({ prefix: "" }),
  });
  defineQuery({
    output: z.object({ pong: z.boolean() }),
    // @ts-expect-error execute demanding a field outside the preset is rejected
    execute: (_ctx: { extra(): void }) => ({ pong: true }),
  });
  defineQuery({
    output: z.object({ pong: z.boolean() }),
    // @ts-expect-error sdk lives on bb, not on Context
    execute: (_ctx: { sdk: unknown }) => ({ pong: true }),
  });
  defineQuery({
    output: z.object({ pong: z.boolean() }),
    // @ts-expect-error CommandContext fields are not RPC fields
    execute: (_ctx: { cwd: string }) => ({ pong: true }),
  });
  const greedyTool = defineTool({
    description: "wants more than the preset provides",
    parameters: z.object({}),
    execute: (_ctx: ToolContext<{ extra(): void }>) => "x",
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    // @ts-expect-error a tool demanding a field outside the preset is rejected
    agents: { tools: { greedy: greedyTool } },
  });
  void definePlugin({ pluginId: "demo-ns", rpc: demo });
  const plugin = definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
  });
  type PluginRPC = (typeof plugin)["rpc"];
  const fromPlugin: PluginRPC = demo;
  const toDemo: typeof demo = fromPlugin;
  void toDemo;
}
void typeOnly;
