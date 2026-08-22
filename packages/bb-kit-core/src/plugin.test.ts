import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { definePlugin } from "./plugin.ts";
import { defineMutation, defineQuery, defineRPC } from "./rpc.ts";
import type { ClientFor } from "./rpc.ts";
import { defineCommand } from "./cli.ts";
import { noInputSchema } from "./internal/no-input.ts";
import type { HostSeam } from "./internal/host.ts";

type Ctx = { prefix: string };

const echo = defineQuery({
  input: z.object({ path: z.string() }),
  output: z.object({ path: z.string() }),
  handler: (context: Ctx, input) => ({ path: context.prefix + input.path }),
});

const ping = defineQuery({
  output: z.object({ pong: z.boolean() }),
  handler: (_context: Ctx) => ({ pong: true }),
});

const readURL = defineMutation({
  input: z.object({ url: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: (_context: Ctx, _input) => ({ ok: true }),
});

const demo = defineRPC({ namespace: "demo-ns", procedures: { echo, ping, readURL } });
type DemoClient = ClientFor<typeof demo>;

const status = defineCommand({
  summary: "Show status",
  run: async (client: DemoClient, { context }) => {
    const result = await client.ping();
    return { exitCode: 0, stdout: `pong=${result.pong} cwd=${context.cwd ?? ""}\n` };
  },
});

type RPCArgs = {
  contract: Parameters<HostSeam["rpc"]["register"]>[0];
  handlers: Parameters<HostSeam["rpc"]["register"]>[1];
};
type CLIRegistration = Parameters<HostSeam["cli"]["register"]>[0];

function fakeHost() {
  const captured: { order: string[]; rpc?: RPCArgs; cli?: CLIRegistration } = { order: [] };
  const bb: HostSeam = {
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
  };
  return { bb, captured };
}

async function loadPlugin() {
  const { bb, captured } = fakeHost();
  let setupExtras: { client: DemoClient; context: Ctx } | undefined;
  const plugin = definePlugin({
    rpc: demo,
    cli: { summary: "Demo plugin", commands: { status } },
    // Async on purpose: the factory must await it.
    context: async () => ({ prefix: "p:" }),
    setup(_bb, extras) {
      captured.order.push("setup");
      setupExtras = extras;
    },
  });
  await plugin(bb);
  return { captured, setupExtras };
}

test("registration order: rpc, cli, then setup", async () => {
  const { captured } = await loadPlugin();
  assert.deepEqual(captured.order, ["rpc", "cli", "setup"]);
});

test("contract uses wire names; no-input procedures get the vendored schema", async () => {
  const { captured } = await loadPlugin();
  const contract = captured.rpc?.contract ?? {};
  assert.deepEqual(Object.keys(contract).sort(), [
    "demo_ns_echo",
    "demo_ns_ping",
    "demo_ns_read_url",
  ]);
  assert.equal(contract["demo_ns_ping"]?.input, noInputSchema);
  assert.notEqual(contract["demo_ns_echo"]?.input, noInputSchema);
});

test("wire handlers invoke the procedure directly with the context (no re-validation)", async () => {
  const { captured } = await loadPlugin();
  const handlers = captured.rpc?.handlers ?? {};
  assert.deepEqual(await handlers["demo_ns_echo"]?.({ path: "x" }), { path: "p:x" });
  assert.deepEqual(await handlers["demo_ns_ping"]?.(null), { pong: true });
});

test("cli registration: namespace as name, summary, metadata for every command", async () => {
  const { captured } = await loadPlugin();
  assert.equal(captured.cli?.name, "demo-ns");
  assert.equal(captured.cli?.summary, "Demo plugin");
  const commands = captured.cli?.commands ?? [];
  const byName = new Map(commands.map((command) => [command.name, command]));
  assert.deepEqual([...byName.keys()].sort(), ["rpc", "status"]);
  assert.equal(byName.get("status")?.summary, "Show status");
  assert.equal(byName.get("rpc")?.summary, "Call a procedure (JSON object in, JSON object out)");
  assert.equal(typeof byName.get("status")?.usage, "string");
});

test("omitted cli: default summary, only the rpc subtree", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({ rpc: demo, context: () => ({ prefix: "q:" }) })(bb);
  assert.equal(captured.cli?.summary, "RPC access for the demo-ns plugin");
  assert.deepEqual(
    (captured.cli?.commands ?? []).map((command) => command.name),
    ["rpc"],
  );
});

test("setup receives the validating client and the resolved context", async () => {
  const { setupExtras } = await loadPlugin();
  assert.ok(setupExtras);
  assert.deepEqual(setupExtras.context, { prefix: "p:" });
  assert.deepEqual(await setupExtras.client.ping(), { pong: true });
});

test("reserved command names throw at define time", () => {
  const loose = defineCommand({ summary: "x", run: () => ({ exitCode: 0 }) });
  for (const key of ["rpc", "help"]) {
    assert.throws(
      () =>
        definePlugin({
          rpc: demo,
          cli: { summary: "x", commands: { [key]: loose } },
          context: (): Ctx => ({ prefix: "" }),
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

test("curated command runs with the client and the invocation context", async () => {
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
    stdout: '{"path":"p:a"}\n',
  });
});

test("rpc subtree: kebab-cased procedure names", async () => {
  const cli = await dispatcher();
  assert.deepEqual(await cli.run(["rpc", "read-url", '{"url":"u"}'], {}), {
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
  assert.match(result.stdout ?? "", /read-url/);
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
  const greedy = defineCommand({
    summary: "wants more than the client provides",
    run: (_client: DemoClient & { extra(): void }) => ({ exitCode: 0 }),
  });
  void definePlugin({
    rpc: demo,
    // @ts-expect-error a command demanding a superset of the client is rejected
    cli: { summary: "x", commands: { greedy } },
    context: (): Ctx => ({ prefix: "" }),
  });
  // @ts-expect-error the context factory must satisfy the handlers' demand
  void definePlugin({ rpc: demo, context: () => ({}) });
  void definePlugin({ rpc: demo, context: (): Ctx => ({ prefix: "" }) });
}
void typeOnly;
