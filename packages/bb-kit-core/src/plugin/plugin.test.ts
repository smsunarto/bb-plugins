import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { definePlugin, type Context } from "./plugin.ts";
import { defineCommand, type CommandContext } from "../cli/cli.ts";
import { defineMutation, defineQuery, noInputSchema } from "../rpc/rpc.ts";
import type { HostSeam } from "./host.ts";

const echo = defineQuery({
  input: z.object({ path: z.string() }),
  output: z.object({ path: z.string() }),
  handler: (_context: Context, input) => ({ path: input.path }),
});

const ping = defineQuery({
  output: z.object({ pong: z.boolean() }),
  handler: (_context: Context) => ({ pong: true }),
});

const readURL = defineMutation({
  input: z.object({ url: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: (_context: Context, _input) => ({ ok: true }),
});

const demo = { echo, ping, readURL };

const status = defineCommand({
  summary: "Show status",
  run: async (context: CommandContext<Context>) => {
    const result = await ping.handler(context);
    return { exitCode: 0, stdout: `pong=${result.pong} cwd=${context.cli.cwd ?? ""}\n` };
  },
});

type RPCArgs = {
  contract: Parameters<HostSeam["rpc"]["register"]>[0];
  handlers: Parameters<HostSeam["rpc"]["register"]>[1];
};
type CLIRegistration = Parameters<HostSeam["cli"]["register"]>[0];

function fakeHost() {
  const captured: { order: string[]; rpc?: RPCArgs; cli?: CLIRegistration } = { order: [] };
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
  const loose = defineCommand({ summary: "x", run: () => ({ exitCode: 0 }) });
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

// ---- type-level pins ------------------------------------------------

function typeOnly() {
  const greedyCommand = defineCommand({
    summary: "wants more than the preset provides",
    run: (_context: { extra(): void }) => ({ exitCode: 0 }),
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    // @ts-expect-error a command demanding a field outside the preset is rejected
    cli: { greedy: greedyCommand },
  });
  const usesCli = defineCommand({
    summary: "reads cli from CommandContext",
    run: (context: CommandContext<Context>) => ({
      exitCode: 0,
      stdout: context.cli.cwd ?? "",
    }),
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    cli: { usesCli },
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
    context: () => ({ prefix: "" }),
  });
  const greedyRPC = defineQuery({
    output: z.object({ pong: z.boolean() }),
    handler: (_context: { repository: unknown }) => ({ pong: true }),
  });
  void definePlugin({
    pluginId: "demo-ns",
    // @ts-expect-error a handler may not demand a field outside the preset
    rpc: { greedy: greedyRPC },
  });
  const greedyHostField = defineQuery({
    output: z.object({ pong: z.boolean() }),
    handler: (_context: { sdk: unknown }) => ({ pong: true }),
  });
  void definePlugin({
    pluginId: "demo-ns",
    // @ts-expect-error sdk lives on bb, not on Context
    rpc: { greedy: greedyHostField },
  });
  const wantsCliOnRPC = defineQuery({
    output: z.object({ pong: z.boolean() }),
    handler: (_context: CommandContext<Context>) => ({ pong: true }),
  });
  void definePlugin({
    pluginId: "demo-ns",
    // @ts-expect-error cli is a Command field, not an RPC field
    rpc: { ping: wantsCliOnRPC },
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
