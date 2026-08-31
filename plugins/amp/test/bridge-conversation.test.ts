/**
 * Unit tests for `src/bridge/conversation.ts` — the Amp process supervisor
 * extracted in U3. Reuse, retry, and settlement behavior stay pinned through
 * the agent by test/bridge-core.test.ts; this file covers what bridge-core
 * never reached directly: the replayable input queue, lazy spawn, the spawn
 * bag, and the Orb variant.
 */
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import { setImmediate as tick } from "node:timers/promises";
import {
  createAmpConversation,
  createRetryState,
  MultiTurnPrompt,
  runOrb,
  shapesEqual,
  type AmpExecuteFn,
  type SessionShape,
} from "../src/bridge/conversation.ts";
import { toSessionShape } from "../src/bridge/options.ts";

function shape(overrides: Partial<SessionShape> = {}): SessionShape {
  return {
    cwd: "/work/repo",
    mode: "medium",
    dangerouslyAllowAll: false,
    fast: false,
    denied: [],
    mcpConfigDigest: "",
    ...overrides,
  };
}

function mockExecute(scripts: ReadonlyArray<AmpExecuteFn>) {
  const execute = mock<AmpExecuteFn>(() => {
    throw new Error(`unexpected execute() call #${execute.mock.calls.length}`);
  });
  for (const script of scripts) execute.mockImplementationOnce(script);
  return execute;
}

function depsFor(execute: AmpExecuteFn, overrides: Record<string, unknown> = {}) {
  return {
    execute,
    env: { TERM: "dumb" },
    retry: createRetryState(),
    ...overrides,
  } as Parameters<typeof createAmpConversation>[0]["deps"];
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test("MultiTurnPrompt holds handed-off input until commit, then delivers", async () => {
  const prompt = new MultiTurnPrompt();
  const first = prompt.push("one");
  const second = prompt.push("two", { steer: true });
  assert.equal(prompt.hasUndelivered, true);
  const controller = new AbortController();
  const stream = prompt.stream(controller.signal);
  const m1 = (await stream.next()).value;
  const m2 = (await stream.next()).value;
  assert.equal(Object.hasOwn(m1, "steer"), false);
  assert.equal(m2.steer, true);
  // Handed off but uncommitted: still replayable, still undelivered.
  assert.equal(prompt.hasUndelivered, true);
  prompt.commit();
  await first.delivered;
  await second.delivered;
  assert.equal(prompt.hasUndelivered, false);
  controller.abort();
});

test("MultiTurnPrompt replays undelivered input to the next attempt in order", async () => {
  const prompt = new MultiTurnPrompt();
  prompt.push("one").delivered.catch(() => {});
  prompt.push("two").delivered.catch(() => {});
  const attempt1 = new AbortController();
  const s1 = prompt.stream(attempt1.signal);
  const a = (await s1.next()).value;
  const b = (await s1.next()).value;
  attempt1.abort();
  prompt.replay();
  const attempt2 = new AbortController();
  const s2 = prompt.stream(attempt2.signal);
  assert.equal((await s2.next()).value, a);
  assert.equal((await s2.next()).value, b);
  attempt2.abort();
});

test("MultiTurnPrompt close rejects undelivered input, including later pushes", async () => {
  const prompt = new MultiTurnPrompt();
  const before = prompt.push("one");
  prompt.close();
  await assert.rejects(before.delivered, /input closed/);
  await assert.rejects(prompt.push("two").delivered, /input closed/);
  assert.equal(prompt.closed, true);
  assert.equal(prompt.hasUndelivered, false);
});

test("MultiTurnPrompt delivers at handoff once committed", async () => {
  const prompt = new MultiTurnPrompt();
  prompt.commit();
  const entry = prompt.push("one");
  const controller = new AbortController();
  const stream = prompt.stream(controller.signal);
  await stream.next();
  await entry.delivered;
  assert.equal(prompt.hasUndelivered, false);
  controller.abort();
});

test("createAmpConversation never spawns when closed unsent", async () => {
  const execute = mockExecute([]);
  const conversation = createAmpConversation({
    shape: shape(),
    continueFrom: null,
    mcpConfig: null,
    labels: null,
    deps: depsFor(execute),
  });
  await tick();
  assert.equal(execute.mock.calls.length, 0);
  conversation.closeInput();
  assert.deepEqual(await drain(conversation.batches()), []);
  assert.equal(execute.mock.calls.length, 0);
  assert.equal(conversation.closed, true);
  assert.equal(conversation.aborted, false);
});

test("createAmpConversation builds the spawn bag from the shape", async () => {
  const execute = mockExecute([
    async function* ({ prompt }) {
      for await (const _message of prompt as AsyncIterable<unknown>) {
        yield { type: "system" };
        return;
      }
    },
  ]);
  const conversation = createAmpConversation({
    shape: shape({ dangerouslyAllowAll: true, fast: true, denied: ["hammer"] }),
    continueFrom: null,
    mcpConfig: { srv: { command: "x" } } as never,
    labels: ["via-amp-acp"],
    deps: depsFor(execute),
  });
  const sent = conversation.send("hi");
  const received = await drain(conversation.batches());
  await sent;
  assert.equal(execute.mock.calls.length, 1);
  assert.equal(received.length, 1);
  assert.equal(conversation.committed, true);
  const options = execute.mock.calls[0]?.[0].options ?? {};
  assert.equal(options.cwd, "/work/repo");
  assert.equal(options.mode, "medium");
  assert.equal(options.thinking, true);
  assert.equal(options.noArchiveAfterExecute, true);
  assert.equal(options.dangerouslyAllowAll, true);
  assert.deepEqual(options.labels, ["via-amp-acp"]);
  assert.deepEqual(options.mcpConfig, { srv: { command: "x" } });
  assert.deepEqual(options.permissions, [{ tool: "hammer", action: "reject" }]);
  assert.equal(options.continue, undefined);
  assert.equal(options.fast, true);
  const env = options.env as Record<string, string>;
  assert.equal(env.TERM, "dumb");
});

test("createAmpConversation traces a CLI attempt through the first model event", async () => {
  const execute = mockExecute([
    async function* () {
      yield { type: "system", subtype: "init", session_id: "T-1", tools: [] };
      yield {
        type: "assistant",
        session_id: "T-1",
        message: { content: [{ type: "thinking", thinking: "working" }] },
      };
    },
  ]);
  const traces: Array<{
    context: unknown;
    checkpoints: string[];
    outcomes: string[];
  }> = [];
  const conversation = createAmpConversation({
    shape: shape(),
    continueFrom: null,
    mcpConfig: { srv: { command: "x" } } as never,
    labels: null,
    deps: depsFor(execute, {
      startTrace(context: unknown) {
        const record = { context, checkpoints: [] as string[], outcomes: [] as string[] };
        traces.push(record);
        return {
          checkpoint(name: string) {
            record.checkpoints.push(name);
          },
          finish(outcome: string) {
            record.outcomes.push(outcome);
          },
        };
      },
    }),
  });
  conversation.send("hi").catch(() => {});
  await drain(conversation.batches());

  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0]?.context, {
    executor: "local",
    continuation: "fresh",
    mcp: true,
    mode: "medium",
    attempt: 0,
  });
  assert.deepEqual(traces[0]?.checkpoints, ["attempt_entered", "system_init", "first_model_event"]);
  assert.deepEqual(traces[0]?.outcomes, ["ok"]);
});

test("createAmpConversation continues a thread without the fast marker", async () => {
  const execute = mockExecute([
    async function* ({ prompt }) {
      for await (const _message of prompt as AsyncIterable<unknown>) {
        yield { type: "system" };
        return;
      }
    },
  ]);
  const conversation = createAmpConversation({
    shape: shape({ fast: true }),
    continueFrom: "T-1",
    mcpConfig: null,
    labels: null,
    deps: depsFor(execute),
  });
  const sent = conversation.send("hi");
  await drain(conversation.batches());
  await sent;
  const options = execute.mock.calls[0]?.[0].options ?? {};
  assert.equal(options.continue, "T-1");
  assert.equal("labels" in options, false);
  assert.equal("mcpConfig" in options, false);
  assert.equal("permissions" in options, false);
  assert.equal("fast" in options, false);
});

test("createAmpConversation drops an unsupported option and replays the prompt", async () => {
  let firstSeen: unknown;
  let secondSeen: unknown;
  const execute = mockExecute([
    async function* ({ prompt }) {
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      firstSeen = (await iterator.next()).value;
      throw new Error("error: unknown option '--mode'");
    },
    async function* ({ prompt }) {
      for await (const message of prompt as AsyncIterable<unknown>) {
        secondSeen = message;
        yield { type: "system" };
        return;
      }
    },
  ]);
  const retry = createRetryState();
  const conversation = createAmpConversation({
    shape: shape({ dangerouslyAllowAll: true }),
    continueFrom: null,
    mcpConfig: null,
    labels: null,
    deps: depsFor(execute, { retry }),
  });
  const sent = conversation.send("hi");
  const received = await drain(conversation.batches());
  await sent;
  assert.equal(execute.mock.calls.length, 2);
  assert.equal(received.length, 1);
  assert.equal(execute.mock.calls[0]?.[0].options?.mode, "medium");
  assert.equal(execute.mock.calls[1]?.[0].options?.mode, undefined);
  assert.equal(retry.droppedOptions.has("mode"), true);
  assert.equal(retry.attemptedFlags.has("mode"), true);
  assert.notEqual(firstSeen, undefined);
  assert.equal(secondSeen, firstSeen);
});

test("a rejected --settings-file fails instead of falling back to persisted settings", async () => {
  const execute = mockExecute([
    async function* () {
      throw new Error("error: unknown option '--settings-file'");
    },
  ]);
  const conversation = createAmpConversation({
    shape: shape({ dangerouslyAllowAll: false, denied: ["Bash"] }),
    continueFrom: null,
    mcpConfig: null,
    labels: null,
    deps: depsFor(execute, { retry: createRetryState() }),
  });
  // A fatal attempt never settles pending input, so this promise stays open.
  conversation.send("hi").catch(() => {});
  await assert.rejects(drain(conversation.batches()), /--settings-file/);
  // One attempt only. The file carries the explicit dangerouslyAllowAll:false
  // that overrides a user-level true, so dropping it would run the turn with
  // more permission than bb asked for.
  assert.equal(execute.mock.calls.length, 1);
});

test("a rejected --project fails instead of inferring the Orb repository", async () => {
  const execute = mockExecute([
    async function* () {
      throw new Error("error: unknown option '--project'");
    },
  ]);
  const run = runOrb({
    prompt: "go",
    project: "acme/site",
    continueFrom: null,
    shape: shape(),
    labels: null,
    deps: depsFor(execute, { retry: createRetryState() }),
  });
  await assert.rejects(drain(run.batches()), /--project/);
  assert.equal(execute.mock.calls.length, 1);
});

test("runOrb builds the Orb bag and ignores Local-only shape controls", async () => {
  const execute = mockExecute([
    async function* () {
      yield { type: "system" };
    },
  ]);
  const run = runOrb({
    prompt: "go",
    project: "acme/site",
    continueFrom: null,
    shape: shape({ dangerouslyAllowAll: true, fast: true, denied: ["hammer"] }),
    labels: ["via-amp-acp"],
    deps: depsFor(execute),
  });
  const received = await drain(run.batches());
  assert.equal(execute.mock.calls.length, 1);
  assert.equal(received.length, 1);
  assert.equal(execute.mock.calls[0]?.[0].prompt, "go");
  const options = execute.mock.calls[0]?.[0].options ?? {};
  assert.equal(options.executor, "orb");
  assert.equal(options.project, "acme/site");
  assert.equal(options.continue, undefined);
  assert.equal("dangerouslyAllowAll" in options, false);
  assert.equal("mcpConfig" in options, false);
  assert.equal("permissions" in options, false);
  assert.deepEqual(options.labels, ["via-amp-acp"]);
});

test("runOrb continues a thread and drops the project selector", async () => {
  const execute = mockExecute([
    async function* () {
      yield { type: "system" };
    },
  ]);
  const run = runOrb({
    prompt: "go",
    project: "acme/site",
    continueFrom: "T-9",
    shape: shape(),
    labels: null,
    deps: depsFor(execute),
  });
  await drain(run.batches());
  const options = execute.mock.calls[0]?.[0].options ?? {};
  assert.equal(options.continue, "T-9");
  assert.equal("project" in options, false);
});

test("runOrb fails closed on an unknown '--orb-execute' flag", async () => {
  const retry = createRetryState();
  const execute = mockExecute([
    async function* () {
      throw new Error("error: unknown option '--orb-execute'");
    },
  ]);
  const run = runOrb({
    prompt: "go",
    project: null,
    continueFrom: null,
    shape: shape(),
    labels: null,
    deps: depsFor(execute, { retry }),
  });
  await assert.rejects(drain(run.batches()), /--orb-execute/);
  assert.equal(execute.mock.calls.length, 1);
  assert.equal(retry.droppedOptions.size, 0);
});

test("shapesEqual compares denied as a set and every scalar strictly", () => {
  const base = shape({ denied: ["a", "b"] });
  assert.equal(shapesEqual(base, shape({ denied: ["b", "a"] })), true);
  assert.equal(shapesEqual(base, shape({ denied: ["a"] })), false);
  assert.equal(shapesEqual(shape({ denied: ["a", "a"] }), shape({ denied: ["a"] })), true);
  assert.equal(shapesEqual(shape(), shape({ mcpConfigDigest: "x" })), false);
  assert.equal(shapesEqual(shape(), shape({ mode: "ultra" })), false);
  assert.equal(shapesEqual(shape(), shape()), true);
});

test("a Fast thread's second turn keeps the shape its first turn spawned", () => {
  const fastShape = (firstExecution: boolean): SessionShape =>
    toSessionShape({
      cwd: "/work/repo",
      options: { serviceTier: "fast" } as Parameters<typeof toSessionShape>[0]["options"],
      disallowedTools: [],
      mcpConfigDigest: "",
      firstExecution,
    });
  const turnOne = fastShape(true);
  const turnTwo = fastShape(false);

  assert.equal(turnOne.fast, true);
  assert.equal(turnTwo.fast, false);
  // The flip is Amp's own rule, not a user control: `--fast` only applies
  // while the CLI creates the thread. Treating it as a config change aborts
  // a warm CLI and shows a "session replaced" notice on every second turn.
  assert.equal(shapesEqual(turnOne, turnTwo), true);
});
