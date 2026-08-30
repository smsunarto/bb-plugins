import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  definePlugin,
  type Context,
  type PluginErrorReporter,
  type PluginFailure,
} from "./plugin.ts";
import { argv, CommandError, defineCommand } from "../command/command.ts";
import { defineMutation, defineQuery, noInputSchema } from "../rpc/rpc.ts";
import { defineTool, type Session, type ToolContext, type ToolResult } from "../tools/tools.ts";
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

const testSession: Session = {
  thread: { id: "t", title: null, parentThreadId: null, sourceThreadId: null },
  project: { id: "p", kind: "personal", name: "project", gitRemoteUrl: null },
  environment: {
    id: "e",
    name: null,
    path: null,
    workspaceProvisionType: "personal",
    branchName: null,
  },
  host: { id: "h", name: "host" },
  provider: { id: "provider", model: "model", capabilities: { supportsNativeUserQuestion: false } },
  origin: { kind: null, pluginId: null },
};

const status = defineCommand({
  summary: "Show status",
  async execute(ctx) {
    const result = await ping.execute(ctx);
    return { exitCode: 0, stdout: `pong=${result.pong} cwd=${ctx.cwd ?? ""}\n` };
  },
});

const cat = defineCommand({
  summary: "Print a path",
  input: z.object({
    path: argv.argument(z.string(), { description: "repo-relative path" }),
  }),
  execute(_ctx, { path }) {
    return { exitCode: 0, stdout: `${path}\n` };
  },
});

const send = defineCommand({
  summary: "Post a notification",
  input: z.object({
    message: argv.words(z.string().min(1), {
      fallbackOption: true,
      description: "notification text",
    }),
  }),
  execute(_ctx, { message }) {
    return { exitCode: 0, stdout: `${message}\n` };
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

function fakeHost(
  options: Readonly<{ rpcRegisterFailure?: unknown; disposeRegistrationFailure?: unknown }> = {},
) {
  const captured: {
    order: string[];
    rpc?: RPCArgs;
    cli?: CLIRegistration;
    agentTools: ToolRegistration[];
    configure?: ConfigureProvider;
    instructions?: InstructionsProvider;
    disposers: Array<() => void | Promise<void>>;
  } = { order: [], agentTools: [], disposers: [] };
  const bb: HostSeam & {
    sdk: { tag: string };
    storage: { kv: object };
    onDispose(hook: () => void | Promise<void>): void;
  } = {
    rpc: {
      register(contract, handlers) {
        if (options.rpcRegisterFailure !== undefined) {
          throw options.rpcRegisterFailure;
        }
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
    onDispose(hook) {
      if (options.disposeRegistrationFailure !== undefined) {
        throw options.disposeRegistrationFailure;
      }
      captured.disposers.push(hook);
    },
    sdk: { tag: "sdk" },
    storage: { kv: {} },
  };
  return { bb: bb as unknown as BbPluginApi, captured };
}

function recordingReporter() {
  const failures: PluginFailure[] = [];
  const disposeTimeouts: number[] = [];
  const reporter: PluginErrorReporter = {
    capture(failure) {
      failures.push(failure);
      return undefined;
    },
    dispose(timeoutMs) {
      disposeTimeouts.push(timeoutMs);
    },
  };
  return { failures, disposeTimeouts, reporter };
}

function assertNoFailures(failures: readonly PluginFailure[]): void {
  assert.equal(failures.length, 0);
}

async function loadPlugin() {
  const { bb, captured } = fakeHost();
  const plugin = definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    command: { status, cat, send },
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

test("wire RPC failures capture once and preserve the original value", async () => {
  const failure = new Error("wire failed");
  const failing = defineQuery({
    output: z.object({ ok: z.boolean() }),
    execute() {
      throw failure;
    },
  });
  const { bb, captured } = fakeHost();
  const recording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => recording.reporter,
    rpc: { failing },
  })(bb);
  const invocation = captured.rpc?.handlers.failing?.(undefined);
  assert.ok(invocation);
  await assert.rejects(Promise.resolve(invocation), (error: unknown) => error === failure);
  assert.deepEqual(recording.failures, [
    { boundary: "rpc.execute", operation: "failing", error: failure },
  ]);
});

test("a failing reporter cannot replace a wire RPC failure", async () => {
  const failure = new Error("wire failed");
  const failing = defineQuery({
    output: z.object({ ok: z.boolean() }),
    execute() {
      throw failure;
    },
  });
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => ({
      capture() {
        throw new Error("reporting failed");
      },
    }),
    rpc: { failing },
  })(bb);
  const invocation = captured.rpc?.handlers.failing?.(undefined);
  assert.ok(invocation);
  await assert.rejects(Promise.resolve(invocation), (error: unknown) => error === failure);
});

test("cli registration: plugin id as name, summary, metadata for every command", async () => {
  const { captured } = await loadPlugin();
  assert.equal(captured.cli?.name, "demo-ns");
  assert.equal(captured.cli?.summary, "CLI for the demo-ns plugin");
  const commands = captured.cli?.commands ?? [];
  const byName = new Map(commands.map((command) => [command.name, command]));
  assert.deepEqual([...byName.keys()].sort(), ["cat", "rpc", "send", "status"]);
  assert.equal(byName.get("status")?.summary, "Show status");
  assert.equal(byName.get("rpc")?.summary, "Call an RPC (JSON object in, JSON object out)");
  assert.equal(typeof byName.get("status")?.usage, "string");
});

test("omitted command: default summary, only the rpc subtree", async () => {
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

test("error reporter construction fails open", async () => {
  const { bb, captured } = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter() {
      throw new Error("telemetry unavailable");
    },
    rpc: demo,
  })(bb);
  assert.deepEqual(captured.order, ["rpc", "cli"]);
  assert.equal(captured.disposers.length, 0);
});

test("factory failures capture once, dispose once, and preserve identity", async () => {
  const failure = new Error("registration failed");
  const { bb, captured } = fakeHost({ rpcRegisterFailure: failure });
  const recording = recordingReporter();
  await assert.rejects(
    definePlugin({
      pluginId: "demo-ns",
      errorReporter: () => recording.reporter,
      rpc: demo,
    })(bb),
    (error) => error === failure,
  );
  assert.deepEqual(recording.failures, [{ boundary: "plugin.factory", error: failure }]);
  assert.deepEqual(recording.disposeTimeouts, [2_000]);
  assert.equal(captured.disposers.length, 1);
  await captured.disposers[0]?.();
  assert.deepEqual(recording.disposeTimeouts, [2_000]);
});

test("setup failures capture separately and preserve identity", async () => {
  const failure = new Error("setup failed");
  const { bb } = fakeHost();
  const recording = recordingReporter();
  await assert.rejects(
    definePlugin({
      pluginId: "demo-ns",
      errorReporter: () => recording.reporter,
      rpc: demo,
      setup() {
        throw failure;
      },
    })(bb),
    (error) => error === failure,
  );
  assert.deepEqual(recording.failures, [{ boundary: "plugin.setup", error: failure }]);
  assert.deepEqual(recording.disposeTimeouts, [2_000]);
});

test("disposal registration failure disables reporting without failing the plugin", async () => {
  const { bb } = fakeHost({ disposeRegistrationFailure: new Error("hook unavailable") });
  const recording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => recording.reporter,
    rpc: demo,
  })(bb);
  assertNoFailures(recording.failures);
  assert.deepEqual(recording.disposeTimeouts, [2_000]);
});

test("each factory execution owns one reporter and one disposal hook", async () => {
  const first = fakeHost();
  const second = fakeHost();
  const recordings = [recordingReporter(), recordingReporter()];
  let reporterIndex = 0;
  const plugin = definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => recordings[reporterIndex++]?.reporter,
    rpc: demo,
  });
  await plugin(first.bb);
  await plugin(second.bb);
  assert.equal(reporterIndex, 2);
  assert.equal(first.captured.disposers.length, 1);
  assert.equal(second.captured.disposers.length, 1);
  await first.captured.disposers[0]?.();
  await second.captured.disposers[0]?.();
  assert.deepEqual(
    recordings.map((recording) => recording.disposeTimeouts),
    [[2_000], [2_000]],
  );
});

test("setup disposal runs before reporter disposal under BB's LIFO order", async () => {
  const order: string[] = [];
  const { bb, captured } = fakeHost();
  const reporter: PluginErrorReporter = {
    capture: () => undefined,
    dispose() {
      order.push("reporter");
    },
  };
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => reporter,
    rpc: demo,
    setup(setupBb) {
      setupBb.onDispose(() => {
        order.push("setup");
      });
    },
  })(bb);
  for (const dispose of captured.disposers.toReversed()) {
    await dispose();
  }
  assert.deepEqual(order, ["setup", "reporter"]);
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
  const loose = defineCommand({ summary: "x", execute: (_ctx) => ({ exitCode: 0 }) });
  for (const key of ["rpc", "help"]) {
    assert.throws(
      () =>
        definePlugin({
          pluginId: "demo-ns",
          rpc: demo,
          command: { [key]: loose },
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

test("host cli.run: missing required argument is exit 2", async () => {
  const cli = await dispatcher();
  const missing = await cli.run(["cat"], {});
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr ?? "", /missing required argument/);
});

test("host cli.run: words join rest tokens and --message is the fallback", async () => {
  const cli = await dispatcher();
  assert.deepEqual(await cli.run(["send", "build", "is", "done"], {}), {
    exitCode: 0,
    stdout: "build is done\n",
  });
  assert.deepEqual(await cli.run(["send", "--message", "hi"], {}), {
    exitCode: 0,
    stdout: "hi\n",
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

test("RPC CLI reports owned failures but not malformed JSON or input validation", async () => {
  const procedureFailure = new Error("procedure failed");
  const failing = defineQuery({
    output: z.object({ ok: z.boolean() }),
    execute() {
      throw procedureFailure;
    },
  });
  const invalidOutput = defineQuery({
    output: z.object({ ok: z.boolean() }),
    execute() {
      return { ok: true };
    },
  });
  Object.defineProperty(invalidOutput, "execute", {
    value: () => ({ ok: "private output" }),
  });
  const cycle: { link?: unknown } = {};
  cycle.link = cycle;
  const circular = defineQuery({
    output: z.object({ value: z.unknown() }),
    execute() {
      return { value: cycle };
    },
  });
  const { bb, captured } = fakeHost();
  const recording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => recording.reporter,
    rpc: { echo, failing, invalidOutput, circular },
  })(bb);
  const cli = captured.cli;
  assert.ok(cli);

  await cli.run(["rpc", "echo"], {});
  await cli.run(["rpc", "echo", "{bad"], {});
  assertNoFailures(recording.failures);

  await cli.run(["rpc", "failing"], {});
  await cli.run(["rpc", "invalidOutput"], {});
  await cli.run(["rpc", "circular"], {});
  assert.deepEqual(
    recording.failures.map((failure) => ({
      boundary: failure.boundary,
      operation: "operation" in failure ? failure.operation : undefined,
    })),
    [
      { boundary: "rpc.cli", operation: "failing" },
      { boundary: "rpc.cli", operation: "invalidOutput" },
      { boundary: "rpc.cli", operation: "circular" },
    ],
  );
  assert.equal(recording.failures[0]?.error, procedureFailure);
});

test("curated commands report only unexpected non-abort failures", async () => {
  const commandFailure = new Error("command failed");
  const abortFailure = new Error("cancelled");
  abortFailure.name = "AbortError";
  const concurrentFailure = new Error("failed while aborting");
  const crash = defineCommand({
    summary: "Crash",
    execute() {
      throw commandFailure;
    },
  });
  const expected = defineCommand({
    summary: "Expected",
    execute() {
      throw new CommandError("expected", { exitCode: 7 });
    },
  });
  const abort = defineCommand({
    summary: "Abort",
    execute() {
      throw abortFailure;
    },
  });
  const concurrent = defineCommand({
    summary: "Concurrent",
    execute() {
      throw concurrentFailure;
    },
  });
  const { bb, captured } = fakeHost();
  const recording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => recording.reporter,
    rpc: { ping },
    command: { crash, expected, abort, concurrent },
  })(bb);
  const cli = captured.cli;
  assert.ok(cli);
  const controller = new AbortController();
  controller.abort();

  assert.equal((await cli.run(["expected"], {})).exitCode, 7);
  assert.equal((await cli.run(["abort"], { signal: controller.signal })).exitCode, 1);
  assert.equal((await cli.run(["crash"], {})).exitCode, 1);
  assert.equal((await cli.run(["concurrent"], { signal: controller.signal })).exitCode, 1);
  assert.deepEqual(recording.failures, [
    { boundary: "command.execute", operation: "crash", error: commandFailure },
    { boundary: "command.execute", operation: "concurrent", error: concurrentFailure },
  ]);
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
    command: { status },
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
  const session = testSession;
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
  assert.deepEqual(fixed.captured.configure?.(testSession), {
    tools: ["demo_ns_inventory"],
    skills: ["triage"],
  });
  const selected = fakeHost();
  await definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    agents: { tools: { inventory }, skills: () => ["a", "b"] },
  })(selected.bb);
  assert.deepEqual(selected.captured.configure?.(testSession), {
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

test("agent tool reporting preserves sync results, throws, rejections, and abort policy", async () => {
  const syncFailure = new Error("sync tool failed");
  const asyncFailure = new Error("async tool failed");
  const abortFailure = new Error("cancelled");
  abortFailure.name = "AbortError";
  const concurrentFailure = new Error("failed while aborting");
  const syncResult: ToolResult = { content: [{ type: "text", text: "done" }] };
  const tools = {
    sync_result: defineTool({
      description: "Return synchronously",
      parameters: z.object({}),
      execute: () => syncResult,
    }),
    sync_failure: defineTool({
      description: "Throw synchronously",
      parameters: z.object({}),
      execute() {
        throw syncFailure;
      },
    }),
    async_failure: defineTool({
      description: "Reject asynchronously",
      parameters: z.object({}),
      execute: () => Promise.reject(asyncFailure),
    }),
    abort_failure: defineTool({
      description: "Abort",
      parameters: z.object({}),
      execute() {
        throw abortFailure;
      },
    }),
    concurrent_failure: defineTool({
      description: "Fail while aborted",
      parameters: z.object({}),
      execute() {
        throw concurrentFailure;
      },
    }),
    domain_failure: defineTool({
      description: "Return a domain failure",
      parameters: z.object({}),
      execute: (): ToolResult => ({
        content: [{ type: "text", text: "no" }],
        isError: true,
      }),
    }),
  };
  const { bb, captured } = fakeHost();
  const recording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => recording.reporter,
    rpc: { ping },
    agents: { tools },
  })(bb);
  const byName = new Map(captured.agentTools.map((tool) => [tool.name, tool]));
  const active = new AbortController();
  const aborted = new AbortController();
  aborted.abort();
  const invocation = { threadId: "t", projectId: "p", signal: active.signal };
  const abortedInvocation = { ...invocation, signal: aborted.signal };

  const returned = byName.get("demo_ns_sync_result")?.execute({}, invocation);
  assert.equal(returned, syncResult);
  assert.throws(
    () => byName.get("demo_ns_sync_failure")?.execute({}, invocation),
    (error) => error === syncFailure,
  );
  const rejected = byName.get("demo_ns_async_failure")?.execute({}, invocation);
  assert.ok(rejected instanceof Promise);
  await assert.rejects(rejected, (error) => error === asyncFailure);
  assert.throws(
    () => byName.get("demo_ns_abort_failure")?.execute({}, abortedInvocation),
    (error) => error === abortFailure,
  );
  assert.throws(
    () => byName.get("demo_ns_concurrent_failure")?.execute({}, abortedInvocation),
    (error) => error === concurrentFailure,
  );
  assert.deepEqual(byName.get("demo_ns_domain_failure")?.execute({}, invocation), {
    content: [{ type: "text", text: "no" }],
    isError: true,
  });
  assert.deepEqual(recording.failures, [
    { boundary: "agent.tool", operation: "demo_ns_sync_failure", error: syncFailure },
    { boundary: "agent.tool", operation: "demo_ns_async_failure", error: asyncFailure },
    {
      boundary: "agent.tool",
      operation: "demo_ns_concurrent_failure",
      error: concurrentFailure,
    },
  ]);
});

test("agent configure and instructions failures stay synchronous and capture once", async () => {
  const gateFailure = new Error("gate failed");
  const gate = defineTool({
    description: "Gated",
    parameters: z.object({}),
    enabled() {
      throw gateFailure;
    },
    execute: () => "unused",
  });
  const gatedHost = fakeHost();
  const gatedRecording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => gatedRecording.reporter,
    rpc: { ping },
    agents: { tools: { gate } },
  })(gatedHost.bb);
  assert.throws(
    () => gatedHost.captured.configure?.(testSession),
    (error) => error === gateFailure,
  );
  assert.deepEqual(gatedRecording.failures, [{ boundary: "agent.configure", error: gateFailure }]);

  const skillsFailure = new Error("skills failed");
  const skillsHost = fakeHost();
  const skillsRecording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => skillsRecording.reporter,
    rpc: { ping },
    agents: {
      tools: { inventory },
      skills() {
        throw skillsFailure;
      },
    },
  })(skillsHost.bb);
  assert.throws(
    () => skillsHost.captured.configure?.(testSession),
    (error) => error === skillsFailure,
  );
  assert.deepEqual(skillsRecording.failures, [
    { boundary: "agent.configure", error: skillsFailure },
  ]);

  const instructionsFailure = new Error("instructions failed");
  const instructionsHost = fakeHost();
  const instructionsRecording = recordingReporter();
  await definePlugin({
    pluginId: "demo-ns",
    errorReporter: () => instructionsRecording.reporter,
    rpc: { ping },
    agents: {
      tools: { inventory },
      instructions() {
        throw instructionsFailure;
      },
    },
  })(instructionsHost.bb);
  assert.throws(
    () => instructionsHost.captured.instructions?.({ threadId: "t", projectId: "p" }),
    (error) => error === instructionsFailure,
  );
  assert.deepEqual(instructionsRecording.failures, [
    { boundary: "agent.instructions", error: instructionsFailure },
  ]);
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
    command: { usesHostFields },
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    // @ts-expect-error leftover wrapper { summary, commands } is a type error
    command: { summary: "x", commands: { status } },
  });
  void definePlugin({
    pluginId: "demo-ns",
    rpc: demo,
    // @ts-expect-error reserved key rpc is a type error
    command: { rpc: status },
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
