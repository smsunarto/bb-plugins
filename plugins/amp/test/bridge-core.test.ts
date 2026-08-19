import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import type { UserInputMessage } from "@ampcode/sdk";
import {
  AmpBridgeAgent,
  AMP_ACP_LABEL,
  convertMcpServers,
  memorySessionStore,
  routeAmpPrompt,
  CONFIG_MODE,
  CONFIG_REASONING,
  CONFIG_PERMISSION,
  unsupportedOptionFrom,
  type BridgeDeps,
  type AmpExecuteFn,
  type AmpExecuteOptions,
  type AmpUserInputMessage,
} from "../src/bridge-core.ts";
import type { AmpStreamMessage } from "../src/translate.ts";
import type { OracleReportStore, OracleTraceEventInput } from "../src/oracle-report-store.ts";
import type { SteeringInputMonitor } from "../src/bb-steering-monitor.ts";
import { permissionModeFromBb } from "../src/permission-mode.ts";
import { AMP_CLI_SHIM_FAST_ENV } from "../src/amp-cli-shim.ts";

const THREAD = "T-test-thread";

function sysInit(threadId = THREAD): AmpStreamMessage {
  return { type: "system", subtype: "init", session_id: threadId, cwd: "/", tools: [] };
}

function assistant(content: unknown, threadId = THREAD): AmpStreamMessage {
  return {
    type: "assistant",
    session_id: threadId,
    message: { content } as { content: unknown },
  };
}

function assistantStop(
  text: string,
  stopReason: "end_turn" | "max_tokens" | "refusal" = "end_turn",
  threadId = THREAD,
): AmpStreamMessage {
  return {
    ...assistant([{ type: "text", text }], threadId),
    message: {
      content: [{ type: "text", text }],
      stop_reason: stopReason,
    },
  };
}

function userMsg(content: unknown, threadId = THREAD): AmpStreamMessage {
  return { type: "user", session_id: threadId, message: { content } as { content: unknown } };
}

function userEcho(text: string, threadId = THREAD): AmpStreamMessage {
  return {
    type: "user",
    session_id: threadId,
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  };
}

function success(threadId = THREAD, extra: Record<string, unknown> = {}): AmpStreamMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    duration_ms: 1,
    num_turns: 1,
    session_id: threadId,
    ...extra,
  };
}

interface RecordedCall {
  prompt: string;
  options?: AmpExecuteOptions;
}

function scriptedExecute(script: (call: RecordedCall, index: number) => AmpStreamMessage[]): {
  fn: AmpExecuteFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fn: AmpExecuteFn = ({ prompt, options, signal }) => {
    const call: RecordedCall = {
      prompt: typeof prompt === "string" ? prompt : "",
      options,
    };
    calls.push(call);
    return (async function* () {
      if (typeof prompt !== "string") {
        const input = await prompt[Symbol.asyncIterator]().next();
        if (!input.done) call.prompt = inputMessageText(input.value);
      }
      const messages = script(call, calls.length - 1);
      for (const message of messages) {
        signal?.throwIfAborted();
        yield message;
      }
    })();
  };
  return { fn, calls };
}

function collector(): {
  updates: SessionNotification[];
  client: { sessionUpdate: (n: SessionNotification) => Promise<void> };
} {
  const updates: SessionNotification[] = [];
  return {
    updates,
    client: {
      sessionUpdate: async (notification) => {
        updates.push(notification);
      },
    },
  };
}

function stubOracleReports(): OracleReportStore {
  return {
    start: () => "11111111-1111-4111-8111-111111111111",
    append: () => true,
    complete: () => true,
  };
}

async function newAgentSession(
  execute: AmpExecuteFn,
  updates = collector(),
  deps: Omit<BridgeDeps, "execute" | "store" | "oracleReports"> = {},
) {
  const agent = new AmpBridgeAgent(updates.client, {
    execute,
    store: memorySessionStore(),
    oracleReports: stubOracleReports(),
    ...deps,
  });
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });
  return { agent, sessionId: session.sessionId, session, updates };
}

const textPrompt = (text: string) => [{ type: "text" as const, text }];

function inputMessageText(message: UserInputMessage): string {
  return message.message.content.map((block) => block.text).join("");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test condition");
}

test("a case-insensitive standalone /orb token routes from anywhere and is removed", () => {
  for (const [input, expected] of [
    ["/orb fix the test", "fix the test"],
    ["fix /ORB the test", "fix the test"],
    ["fix the test /oRb", "fix the test"],
    ["first line\n/orb\nlast line", "first line last line"],
  ]) {
    const routed = routeAmpPrompt(textPrompt(input));
    assert.equal(routed.prompt.replace(/\s+/gu, " ").trim(), expected);
    assert.equal(routed.prompt.includes("/orb"), false);
    assert.equal(routed.requestedTarget, "orb");
    assert.equal(routed.directiveOnly, false);
  }
});

test("Orb routing strips only the token and preserves unrelated whitespace", () => {
  assert.deepEqual(routeAmpPrompt(textPrompt("  keep\n/orb\n  indentation  ")), {
    prompt: "  keep\n\n  indentation  ",
    requestedTarget: "orb",
    directiveOnly: false,
  });
});

test("Orb routing ignores partial words and attached resource contents", () => {
  assert.deepEqual(routeAmpPrompt(textPrompt("check /orbital behavior")), {
    prompt: "check /orbital behavior",
    requestedTarget: null,
    directiveOnly: false,
  });
  assert.deepEqual(
    routeAmpPrompt([
      ...textPrompt("review this file"),
      {
        type: "resource",
        resource: { uri: "file:///tmp/example.txt", mimeType: "text/plain", text: "/orb" },
      },
    ]),
    {
      prompt: 'review this file\n<context ref="file:///tmp/example.txt">\n/orb\n</context>\n',
      requestedTarget: null,
      directiveOnly: false,
    },
  );
});

test("Orb routing ignores bb system instructions and agent-only plugin context", () => {
  const system = "<system_instructions>\nNever write /orb by itself.\n</system_instructions>";
  const context = 'Context for @issue (resolved by plugin "tracker"):\n\n/orb';
  assert.deepEqual(
    routeAmpPrompt([
      { type: "text", text: system },
      { type: "text", text: "work locally" },
      { type: "text", text: context },
    ]),
    {
      prompt: `${system}work locally${context}`,
      requestedTarget: null,
      directiveOnly: false,
    },
  );

  const routed = routeAmpPrompt([
    { type: "text", text: system },
    { type: "text", text: "use /orb for this task" },
    { type: "text", text: context },
  ]);
  assert.equal(routed.requestedTarget, "orb");
  assert.equal(routed.prompt.includes("use /orb"), false);
  assert.equal(routed.prompt.includes("Never write /orb"), true);
  assert.equal(routed.prompt.endsWith(context), true);
});

test("Orb routing fails safe for bb-generated primary text", () => {
  for (const generated of [
    "[bb message from thread:thr_source]\n\n/orb do this",
    "[bb system]\n\n/orb continue the task",
    "Please continue.",
    "[image attachment: https://example.test/orb.png]",
  ]) {
    const routed = routeAmpPrompt([
      { type: "text", text: generated },
      { type: "text", text: "/orb hidden follow-up" },
    ]);
    assert.equal(routed.requestedTarget, null);
    assert.equal(routed.prompt, `${generated}/orb hidden follow-up`);
  }
});

test("initialize advertises protocol 1, loadSession, remote MCP, and no image support", async () => {
  const { agent } = await newAgentSession(scriptedExecute(() => []).fn);
  const response = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  assert.equal(response.protocolVersion, 1);
  assert.equal(response.agentCapabilities?.loadSession, true);
  assert.equal(response.agentCapabilities?.promptCapabilities?.image, false);
  assert.equal(response.agentCapabilities?.mcpCapabilities?.http, true);
  assert.equal(response.agentCapabilities?.mcpCapabilities?.sse, true);
  assert.equal(response.authMethods, undefined);
});

test("bb thread permissions map to Amp permission modes", () => {
  assert.equal(permissionModeFromBb("full"), "bypass");
  assert.equal(permissionModeFromBb("accept-edits"), "default");
  assert.equal(permissionModeFromBb("auto"), "default");
  assert.equal(permissionModeFromBb("unknown"), null);
});

test("newSession exposes the model, no reasoning control, and permission config options", async () => {
  const { session } = await newAgentSession(scriptedExecute(() => []).fn);
  const options = session.configOptions ?? [];
  const byId = new Map(options.map((option) => [option.id, option]));
  assert.equal(byId.get(CONFIG_MODE)?.category, "model");
  assert.equal(byId.get(CONFIG_MODE)?.currentValue, "medium");
  const reasoning = options.find((option) => option.category === "thought_level");
  assert.equal(reasoning?.currentValue, "default");
  assert.deepEqual(reasoning?.options, [{ value: "default", name: "Amp mode default" }]);
  assert.equal(byId.get(CONFIG_PERMISSION)?.category, "mode");
});

test("prompt streams thought, message, and tool call updates in order and returns end_turn", async () => {
  const { fn, calls } = scriptedExecute(() => [
    sysInit(),
    assistant([
      { type: "thinking", thinking: "pondering" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tu-1", name: "Bash", input: { cmd: "ls -la" } },
    ]),
    userMsg([{ type: "tool_result", tool_use_id: "tu-1", content: "file.txt", is_error: false }]),
    assistant([{ type: "text", text: "done" }]),
    success(),
  ]);
  const { agent, sessionId, updates } = await newAgentSession(fn);

  const response = await agent.prompt({ sessionId, prompt: textPrompt("list files") });
  assert.equal(response.stopReason, "end_turn");
  assert.equal(calls[0].prompt, "list files");
  assert.equal(calls[0].options?.mode, "medium");
  // No effort is sent unless one is picked: Amp's mode carries its own default.
  assert.equal("effort" in (calls[0].options ?? {}), false);
  assert.equal(calls[0].options?.continue, undefined);
  assert.equal(calls[0].options?.dangerouslyAllowAll, false);
  assert.deepEqual(calls[0].options?.labels, [AMP_ACP_LABEL]);

  const kinds = updates.updates.map((n) => n.update.sessionUpdate);
  assert.deepEqual(kinds, [
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
    "agent_message_chunk",
  ]);

  const toolCall = updates.updates[2].update as Record<string, unknown>;
  assert.equal(toolCall.toolCallId, "tu-1");
  assert.equal(toolCall.status, "pending");
  assert.equal(toolCall.kind, "execute");
  assert.equal(toolCall.title, "Bash: ls -la");
  assert.deepEqual(toolCall.rawInput, { cmd: "ls -la" });

  const toolUpdate = updates.updates[3].update as Record<string, unknown>;
  assert.equal(toolUpdate.toolCallId, "tu-1");
  assert.equal(toolUpdate.status, "completed");
});

test("execute invocation contract: thinking on, archive suppressed", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn);
  await agent.prompt({ sessionId, prompt: textPrompt("go") });
  assert.equal(calls[0].options?.thinking, true);
  assert.equal(calls[0].options?.noArchiveAfterExecute, true);
});

test("bb Fast marks only a new Local Amp thread for the CLI shim", async () => {
  let resolutions = 0;
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn, collector(), {
    resolveFastMode: async () => {
      resolutions += 1;
      return true;
    },
  });

  await agent.prompt({ sessionId, prompt: textPrompt("fast") });
  await agent.prompt({ sessionId, prompt: textPrompt("continued fast thread") });

  assert.equal(calls[0].options?.env?.[AMP_CLI_SHIM_FAST_ENV], "1");
  assert.equal(calls[1].options?.env?.[AMP_CLI_SHIM_FAST_ENV], undefined);
  assert.equal(resolutions, 1);
});

test("Orb execution passes the executor and optional Amp project", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn, collector(), {
    orbProject: " owner/repo ",
    resolveFastMode: async () => true,
  });
  await agent.prompt({ sessionId, prompt: textPrompt("go /orb now") });
  await agent.prompt({ sessionId, prompt: textPrompt("continue") });
  assert.equal(calls[0].prompt?.replace(/\s+/gu, " ").trim(), "go now");
  assert.equal(calls[0].options?.executor, "orb");
  assert.equal(calls[0].options?.project, "owner/repo");
  assert.equal(calls[0].options?.dangerouslyAllowAll, undefined);
  assert.equal(calls[0].options?.mcpConfig, undefined);
  assert.equal(calls[0].options?.env?.[AMP_CLI_SHIM_FAST_ENV], undefined);
  assert.equal(calls[1].options?.executor, "orb");
  assert.equal(calls[1].options?.continue, THREAD);
  assert.equal(calls[1].options?.project, undefined);
});

test("a Local Amp thread cannot switch to Orb after it starts", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn);

  await agent.prompt({ sessionId, prompt: textPrompt("start locally") });
  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("move this /orb") }),
    /already runs Local.*new bb thread.*\/orb/,
  );
  assert.equal(calls.length, 1, "the rejected switch must not start Amp");
});

test("a Local execution attempt locks the target before Amp reports a thread id", async () => {
  const calls: RecordedCall[] = [];
  const execute: AmpExecuteFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* (): AsyncGenerator<AmpStreamMessage> {
      throw new Error("failed before init");
    })();
  };
  const { agent, sessionId } = await newAgentSession(execute);

  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("start locally") }),
    /failed before init/,
  );
  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("retry in /orb") }),
    /already runs Local.*new bb thread.*\/orb/,
  );
  assert.equal(calls.length, 1);
});

test("an empty /orb directive fails without changing the session target", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn);

  await assert.rejects(
    agent.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text: "<system_instructions>\nUse the project rules.\n</system_instructions>",
        },
        ...textPrompt(" /orb "),
      ],
    }),
    /Add instructions/,
  );
  await agent.prompt({ sessionId, prompt: textPrompt("run normally") });
  assert.equal(calls[0].options?.executor, undefined);
});

test("local execution ignores an Orb project override", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn, collector(), { orbProject: "owner/repo" });
  await agent.prompt({ sessionId, prompt: textPrompt("go") });
  assert.equal(calls[0].options?.executor, undefined);
  assert.equal(calls[0].options?.project, undefined);
});

test("captures the Amp thread id and continues it on the next prompt", async () => {
  const { fn, calls } = scriptedExecute(() => [
    sysInit(),
    assistant([{ type: "text", text: "ok" }]),
    success(),
  ]);
  const { agent, sessionId } = await newAgentSession(fn);

  await agent.prompt({ sessionId, prompt: textPrompt("one") });
  await agent.prompt({ sessionId, prompt: textPrompt("two") });

  assert.equal(calls[0].options?.continue, undefined);
  assert.equal(calls[1].options?.continue, THREAD);
});

test("accepted bb steering is marked for Amp and its queued ACP copy is suppressed", async () => {
  let emitSteering: ((input: ContentBlock[]) => void) | undefined;
  const monitorSignals: AbortSignal[] = [];
  const monitor: SteeringInputMonitor = {
    async run(onInput, signal) {
      emitSteering = onInput;
      monitorSignals.push(signal);
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  const receivedInputs: string[][] = [];
  let executeCalls = 0;
  const execute: AmpExecuteFn = ({ prompt }) => {
    const call = executeCalls;
    executeCalls += 1;
    return (async function* () {
      assert.notEqual(typeof prompt, "string");
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      const inputs: string[] = [];
      receivedInputs[call] = inputs;
      const initial = await iterator.next();
      assert.equal(initial.done, false);
      assert.equal(initial.value.steer, undefined);
      inputs.push(inputMessageText(initial.value));
      yield sysInit();
      if (call === 0) {
        const steering = await iterator.next();
        assert.equal(steering.done, false);
        assert.equal(steering.value.steer, true);
        inputs.push(inputMessageText(steering.value));
      }
      yield success();
    })();
  };
  const { agent, sessionId } = await newAgentSession(execute, collector(), {
    createSteeringMonitor: async () => monitor,
  });

  const activePrompt = agent.prompt({ sessionId, prompt: textPrompt("start") });
  await waitUntil(() => emitSteering !== undefined && receivedInputs[0]?.length === 1);
  assert.ok(emitSteering);
  emitSteering(textPrompt("change direction"));
  assert.equal((await activePrompt).stopReason, "end_turn");

  assert.equal(executeCalls, 1);
  assert.deepEqual(receivedInputs[0], ["start", "change direction"]);
  assert.equal(monitorSignals[0]?.aborted, true);

  const duplicate = await agent.prompt({
    sessionId,
    prompt: textPrompt("change direction"),
  });
  assert.equal(duplicate.stopReason, "end_turn");
  assert.equal(executeCalls, 1, "bb's delayed ACP copy must not execute twice");

  const next = await agent.prompt({ sessionId, prompt: textPrompt("next turn") });
  assert.equal(next.stopReason, "end_turn");
  assert.equal(executeCalls, 2);
  assert.deepEqual(receivedInputs[1], ["next turn"]);
});

test("Local prompts reuse one Amp process and leave its input open between turns", async () => {
  const monitor: SteeringInputMonitor = {
    async run(_onInput, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  let executeCalls = 0;
  let inputClosed = false;
  const inputs: AmpUserInputMessage[] = [];
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      executeCalls += 1;
      assert.notEqual(typeof prompt, "string");
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      for (let turn = 0; ; turn += 1) {
        const input = await iterator.next();
        if (input.done) {
          inputClosed = true;
          return;
        }
        inputs.push(input.value);
        if (turn === 0) yield sysInit();
        yield userEcho(inputMessageText(input.value));
        yield assistantStop(`done ${turn + 1}`);
      }
    })();
  const { agent, sessionId } = await newAgentSession(execute, collector(), {
    createSteeringMonitor: async () => monitor,
  });

  const first = await agent.prompt({ sessionId, prompt: textPrompt("first") });
  assert.equal(first.stopReason, "end_turn");
  assert.equal(executeCalls, 1);
  assert.equal(inputClosed, false);

  const second = await agent.prompt({ sessionId, prompt: textPrompt("second") });

  assert.equal(second.stopReason, "end_turn");
  assert.equal(executeCalls, 1);
  assert.deepEqual(inputs.map(inputMessageText), ["first", "second"]);
  assert.deepEqual(
    inputs.map((input) => input.steer),
    [undefined, undefined],
  );
  assert.equal(inputClosed, false);

  await agent.shutdown();
  assert.equal(inputClosed, true);
});

test("an unexpected Local output end rejects the turn and restarts cleanly", async () => {
  let executeCalls = 0;
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      const call = executeCalls++;
      assert.notEqual(typeof prompt, "string");
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      if (call === 0) {
        yield sysInit();
        return;
      }
      yield assistantStop("recovered");
    })();
  const { agent, sessionId } = await newAgentSession(execute);

  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("first") }),
    /ended before the turn completed/,
  );
  const response = await agent.prompt({ sessionId, prompt: textPrompt("second") });

  assert.equal(response.stopReason, "end_turn");
  assert.equal(executeCalls, 2);
});

async function assertLateLocalTerminalRetries(terminal: AmpStreamMessage): Promise<void> {
  let executeCalls = 0;
  let releaseLateTerminal!: () => void;
  const lateTerminal = new Promise<void>((resolve) => {
    releaseLateTerminal = resolve;
  });
  const received: string[] = [];
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      const call = executeCalls++;
      assert.notEqual(typeof prompt, "string");
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      const input = await iterator.next();
      assert.equal(input.done, false);
      received.push(inputMessageText(input.value));
      if (call === 0) {
        yield sysInit();
        yield assistantStop("first done");
        await lateTerminal;
        yield terminal;
        return;
      }
      yield userEcho(inputMessageText(input.value));
      yield assistantStop("second done");
    })();
  const { agent, sessionId } = await newAgentSession(execute);

  assert.equal(
    (await agent.prompt({ sessionId, prompt: textPrompt("first") })).stopReason,
    "end_turn",
  );
  const second = agent.prompt({ sessionId, prompt: textPrompt("second") });
  releaseLateTerminal();
  assert.equal((await second).stopReason, "end_turn");
  assert.equal(executeCalls, 2);
  assert.deepEqual(received, ["first", "second"]);
}

test("a late Local result cannot settle the next prompt", async () => {
  await assertLateLocalTerminalRetries(success());
});

test("a late Local terminal system error cannot reject the next prompt", async () => {
  await assertLateLocalTerminalRetries({
    type: "system",
    subtype: "error_during_execution",
    error: "stale failure",
    session_id: THREAD,
  });
});

test("a late Local result closes the idle runtime before awaited reporting", async () => {
  let releaseLateTerminal!: () => void;
  const lateTerminal = new Promise<void>((resolve) => {
    releaseLateTerminal = resolve;
  });
  let reportingDenial = false;
  let releaseReport!: () => void;
  const reportReleased = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  const updates = collector();
  const client = {
    async sessionUpdate(notification: SessionNotification) {
      updates.updates.push(notification);
      const content = (notification.update as { content?: { text?: string } }).content;
      if (!content?.text?.includes("Amp denied tool calls")) return;
      reportingDenial = true;
      await reportReleased;
    },
  };
  let executeCalls = 0;
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      const call = executeCalls++;
      assert.notEqual(typeof prompt, "string");
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      const input = await iterator.next();
      assert.equal(input.done, false);
      if (call === 0) {
        yield sysInit();
        yield assistantStop("first done");
        await lateTerminal;
        yield success(THREAD, { permission_denials: ["stale tool"] });
        return;
      }
      yield assistantStop("second done");
    })();
  const agent = new AmpBridgeAgent(client, {
    execute,
    store: memorySessionStore(),
    oracleReports: stubOracleReports(),
  });
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });

  assert.equal(
    (await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("first") })).stopReason,
    "end_turn",
  );
  releaseLateTerminal();
  await waitUntil(() => reportingDenial);
  const second = agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("second") });
  releaseReport();

  assert.equal((await second).stopReason, "end_turn");
  assert.equal(executeCalls, 2);
  await agent.shutdown();
});

async function assertLateLocalTerminalStopsRetry(action: "cancel" | "shutdown"): Promise<void> {
  let monitorRun = 0;
  let cleanupStarted = false;
  let releaseCleanup!: () => void;
  const monitor: SteeringInputMonitor = {
    async run(_onInput, signal) {
      const blockCleanup = monitorRun++ === 1;
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          if (!blockCleanup) {
            resolve();
            return;
          }
          cleanupStarted = true;
          releaseCleanup = resolve;
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  let releaseLateTerminal!: () => void;
  const lateTerminal = new Promise<void>((resolve) => {
    releaseLateTerminal = resolve;
  });
  let executeCalls = 0;
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      const call = executeCalls++;
      assert.notEqual(typeof prompt, "string");
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      const input = await iterator.next();
      assert.equal(input.done, false);
      if (call === 0) {
        yield sysInit();
        yield assistantStop("first done");
        await lateTerminal;
        yield success();
        return;
      }
      yield userEcho(inputMessageText(input.value));
      yield assistantStop("unexpected retry");
    })();
  const { agent, sessionId } = await newAgentSession(execute, collector(), {
    createSteeringMonitor: async () => monitor,
  });

  assert.equal(
    (await agent.prompt({ sessionId, prompt: textPrompt("first") })).stopReason,
    "end_turn",
  );
  const second = agent.prompt({ sessionId, prompt: textPrompt("second") });
  releaseLateTerminal();
  await waitUntil(() => cleanupStarted);
  const stopping = action === "cancel" ? agent.cancel({ sessionId }) : agent.shutdown();
  releaseCleanup();
  await stopping;

  assert.equal((await second).stopReason, "cancelled");
  assert.equal(executeCalls, 1);
  await agent.shutdown();
}

test("cancel during a late Local terminal does not retry the prompt", async () => {
  await assertLateLocalTerminalStopsRetry("cancel");
});

test("shutdown during a late Local terminal does not retry the prompt", async () => {
  await assertLateLocalTerminalStopsRetry("shutdown");
});

test("a runtime error overrides an assistant stop that has not settled", async () => {
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      assert.notEqual(typeof prompt, "string");
      await (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]().next();
      yield sysInit();
      yield assistantStop("apparently done");
      yield {
        type: "result",
        subtype: "error",
        is_error: true,
        error: "late failure",
        session_id: THREAD,
      };
    })();
  const { agent, sessionId } = await newAgentSession(execute);

  await assert.rejects(agent.prompt({ sessionId, prompt: textPrompt("go") }), /late failure/);
});

test("Local sessions reject overlapping prompts", async () => {
  let started = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      assert.notEqual(typeof prompt, "string");
      await (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]().next();
      started = true;
      yield sysInit();
      await released;
      yield success();
    })();
  const { agent, sessionId } = await newAgentSession(execute);

  const first = agent.prompt({ sessionId, prompt: textPrompt("first") });
  await waitUntil(() => started);
  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("overlap") }),
    /overlapping prompts/,
  );
  release();
  assert.equal((await first).stopReason, "end_turn");
});

test("Local sessions stay active until turn cleanup completes", async () => {
  let cleanupStarted = false;
  let releaseCleanup!: () => void;
  const cleanupReleased = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const client = {
    async sessionUpdate(notification: SessionNotification) {
      const content = (notification.update as { content?: { text?: string } }).content;
      if (!content?.text?.includes("could not be linked to an Amp thread")) return;
      cleanupStarted = true;
      await cleanupReleased;
    },
  };
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      assert.notEqual(typeof prompt, "string");
      await (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]().next();
      yield assistantStop("done", "end_turn", "");
    })();
  const agent = new AmpBridgeAgent(client, {
    execute,
    store: memorySessionStore(),
    oracleReports: stubOracleReports(),
  });
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });

  const first = agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("first") });
  await waitUntil(() => cleanupStarted);
  await assert.rejects(
    agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("overlap") }),
    /overlapping prompts/,
  );
  releaseCleanup();
  assert.equal((await first).stopReason, "end_turn");
});

test("cancel closes the active Amp input stream and steering monitor", async () => {
  let monitorSignal: AbortSignal | undefined;
  const monitor: SteeringInputMonitor = {
    async run(_onInput, signal) {
      monitorSignal = signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  let waitingForMoreInput = false;
  let inputClosed = false;
  const execute: AmpExecuteFn = ({ prompt }) =>
    (async function* () {
      assert.notEqual(typeof prompt, "string");
      const iterator = (prompt as AsyncIterable<UserInputMessage>)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      yield sysInit();
      waitingForMoreInput = true;
      inputClosed = (await iterator.next()).done ?? false;
    })();
  const { agent, sessionId } = await newAgentSession(execute, collector(), {
    createSteeringMonitor: async () => monitor,
  });

  const pending = agent.prompt({ sessionId, prompt: textPrompt("wait") });
  await waitUntil(() => waitingForMoreInput);
  await agent.cancel({ sessionId });

  assert.equal((await pending).stopReason, "cancelled");
  assert.equal(inputClosed, true);
  assert.equal(monitorSignal?.aborted, true);
});

test("cancel aborts the running execute and the session recovers afterwards", async () => {
  let sawAbort = false;
  const calls: RecordedCall[] = [];
  const execute: AmpExecuteFn = ({ prompt, options, signal }) => {
    const index = calls.length;
    calls.push({ prompt, options });
    return (async function* () {
      yield sysInit();
      if (index === 0) {
        await new Promise<never>((_, reject) => {
          const fail = () => {
            sawAbort = true;
            reject(new Error("Amp CLI process was aborted"));
          };
          if (signal?.aborted) return fail();
          signal?.addEventListener("abort", fail);
        });
        return;
      }
      yield assistant([{ type: "text", text: "recovered" }]);
      yield success();
    })();
  };
  const { agent, sessionId } = await newAgentSession(execute);

  const pending = agent.prompt({ sessionId, prompt: textPrompt("long task") });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await agent.cancel({ sessionId });
  const response = await pending;
  assert.equal(response.stopReason, "cancelled");
  assert.equal(sawAbort, true);

  // The same session accepts a follow-up prompt and continues the thread
  // that was captured before the cancel.
  const second = await agent.prompt({ sessionId, prompt: textPrompt("again") });
  assert.equal(second.stopReason, "end_turn");
  assert.equal(calls[1].options?.continue, THREAD);

  // A fresh session after a cancel starts clean (no cancelled carry-over,
  // no thread continuation).
  const fresh = await agent.newSession({ cwd: "/work", mcpServers: [] });
  const third = await agent.prompt({ sessionId: fresh.sessionId, prompt: textPrompt("new") });
  assert.equal(third.stopReason, "end_turn");
  assert.equal(calls[2].options?.continue, undefined);
});

test("changing Local execution config restarts the persistent process", async () => {
  const options: (AmpExecuteOptions | undefined)[] = [];
  const signals: AbortSignal[] = [];
  let firstInputClosed = false;
  const execute: AmpExecuteFn = ({ prompt, options: callOptions, signal }) =>
    (async function* () {
      const call = options.push(callOptions) - 1;
      assert.notEqual(typeof prompt, "string");
      assert.ok(signal);
      signals.push(signal);
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      if (call === 0) yield sysInit();
      yield assistantStop(`done ${call}`);
      const next = await iterator.next();
      if (call === 0) firstInputClosed = next.done ?? false;
    })();
  const { agent, sessionId } = await newAgentSession(execute);

  await agent.prompt({ sessionId, prompt: textPrompt("first") });
  await agent.setSessionConfigOption({
    sessionId,
    configId: CONFIG_MODE,
    value: "high",
  });

  assert.equal(firstInputClosed, true);
  assert.equal(signals[0]?.aborted, true);
  await agent.prompt({ sessionId, prompt: textPrompt("second") });
  assert.equal(options.length, 2);
  assert.equal(options[1]?.mode, "high");
  assert.equal(options[1]?.continue, THREAD);
  await agent.shutdown();
});

test("connection abort shuts down an idle persistent Local process", async () => {
  const connection = new AbortController();
  let inputClosed = false;
  let executeSignal: AbortSignal | undefined;
  const execute: AmpExecuteFn = ({ prompt, signal }) =>
    (async function* () {
      assert.notEqual(typeof prompt, "string");
      executeSignal = signal;
      const iterator = (prompt as AsyncIterable<AmpUserInputMessage>)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      yield sysInit();
      yield assistantStop("done");
      inputClosed = (await iterator.next()).done ?? false;
    })();
  const updates = collector();
  const agent = new AmpBridgeAgent(
    { ...updates.client, signal: connection.signal },
    { execute, store: memorySessionStore(), oracleReports: stubOracleReports() },
  );
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });

  await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("first") });
  connection.abort();
  await waitUntil(() => inputClosed && executeSignal?.aborted === true);

  await assert.rejects(
    agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("after close") }),
    /connection is closed/,
  );
});

test("execution errors soft-fail after surfacing a chunk; max turns maps to max_turn_requests", async () => {
  const { fn, calls } = scriptedExecute((_call, index) => [
    sysInit(),
    index === 0
      ? {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          error: "boom",
          session_id: THREAD,
        }
      : {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          error: "too many turns",
          session_id: THREAD,
        },
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);

  const first = await agent.prompt({ sessionId, prompt: textPrompt("a") });
  assert.equal(first.stopReason, "end_turn");
  const errorChunk = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text?.startsWith("Error: boom");
  });
  assert.ok(errorChunk, "expected an Error: boom message chunk");

  const second = await agent.prompt({ sessionId, prompt: textPrompt("b") });
  assert.equal(second.stopReason, "max_turn_requests");
  assert.equal(calls[1].options?.continue, THREAD);
});

test("assistant stop reasons map max tokens and refusal to ACP", async () => {
  let stopReasonCalls = 0;
  const execute: AmpExecuteFn = ({ signal }) =>
    (async function* () {
      const index = stopReasonCalls++;
      for (const message of [
        sysInit(),
        {
          ...assistant([{ type: "text", text: "partial" }]),
          message: {
            content: [{ type: "text", text: "partial" }],
            stop_reason: index === 0 ? "max_tokens" : "refusal",
          },
        } as AmpStreamMessage,
        success(),
      ]) {
        signal?.throwIfAborted();
        yield message;
      }
    })();
  const { agent, sessionId } = await newAgentSession(execute);
  assert.equal(
    (await agent.prompt({ sessionId, prompt: textPrompt("one") })).stopReason,
    "max_tokens",
  );
  assert.equal(
    (await agent.prompt({ sessionId, prompt: textPrompt("two") })).stopReason,
    "refusal",
  );
});

test("auth-looking result errors carry an amp login hint", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: "Invalid or missing API key",
      session_id: THREAD,
    },
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  await assert.rejects(agent.prompt({ sessionId, prompt: textPrompt("x") }), /amp login/);
  const chunk = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text?.includes("amp login");
  });
  assert.ok(chunk, "expected an auth hint chunk");
});

test("config option changes flow into the next execute options", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);

  const afterMode = await agent.setSessionConfigOption({
    sessionId,
    configId: CONFIG_MODE,
    value: "high",
  });
  const modeOption = afterMode.configOptions.find((o) => o.id === CONFIG_MODE);
  assert.equal(modeOption?.currentValue, "high");
  await agent.setSessionConfigOption({ sessionId, configId: CONFIG_REASONING, value: "default" });
  await agent.setSessionConfigOption({ sessionId, configId: CONFIG_PERMISSION, value: "bypass" });
  const configUpdates = updates.updates.filter(
    (notification) => notification.update.sessionUpdate === "config_option_update",
  );
  assert.equal(configUpdates.length, 3);
  const syncedPermission = configUpdates[2].update as {
    configOptions: { id: string; currentValue?: string | boolean }[];
  };
  assert.equal(
    syncedPermission.configOptions.find((option) => option.id === CONFIG_PERMISSION)?.currentValue,
    "bypass",
  );

  await agent.prompt({ sessionId, prompt: textPrompt("go") });
  assert.equal(calls[0].options?.mode, "high");
  // The thought_level slot is informational, so nothing reaches the CLI from it.
  assert.equal("effort" in (calls[0].options ?? {}), false);
  assert.equal(calls[0].options?.dangerouslyAllowAll, true);

  await assert.rejects(
    agent.setSessionConfigOption({ sessionId, configId: CONFIG_MODE, value: "warp" }),
    /Unsupported Amp mode/,
  );
});

test("bb Full starts Local Amp in bypass while Accept Edits forces normal rules", async () => {
  for (const [initialPermission, expected] of [
    ["bypass", true],
    ["default", false],
  ] as const) {
    const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
    const { agent, sessionId, session } = await newAgentSession(fn, collector(), {
      resolveInitialPermission: async () => initialPermission,
    });
    assert.equal(
      session.configOptions?.find((option) => option.id === CONFIG_PERMISSION)?.currentValue,
      initialPermission,
    );

    await agent.prompt({ sessionId, prompt: textPrompt("go") });
    assert.equal(calls[0].options?.dangerouslyAllowAll, expected);
  }
});

test("bb thread permission overrides the safe default", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn, collector(), {
    resolveInitialPermission: async () => "bypass",
  });

  await agent.prompt({ sessionId, prompt: textPrompt("go") });

  assert.equal(calls[0].options?.dangerouslyAllowAll, true);
});

test("loadSession resumes a stored thread without latching a failure", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const store = memorySessionStore();
  store.set("S-restored", { threadId: "T-earlier", executionTarget: "local" });
  const { client } = collector();
  const agent = new AmpBridgeAgent(client, { execute: fn, store });

  const loaded = await agent.loadSession({ sessionId: "S-restored", cwd: "/work", mcpServers: [] });
  assert.ok(loaded.configOptions && loaded.configOptions.length > 0);
  await agent.prompt({ sessionId: "S-restored", prompt: textPrompt("resume") });
  assert.equal(calls[0].options?.continue, "T-earlier");

  const fresh = await agent.newSession({ cwd: "/work", mcpServers: [] });
  assert.equal(agent.sessions.has(fresh.sessionId), true);
});

test("a failed load latches the bridge and blocks bb's fresh Local fallback", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { client } = collector();
  const agent = new AmpBridgeAgent(client, {
    execute: fn,
    store: memorySessionStore(),
  });

  await assert.rejects(
    agent.loadSession({ sessionId: "S-unknown", cwd: "/work", mcpServers: [] }),
    /saved Amp thread and execution target are missing or invalid/,
  );
  await assert.rejects(
    agent.newSession({ cwd: "/work", mcpServers: [] }),
    /refused bb's fresh Local fallback.*Start a new bb thread/,
  );
  assert.equal(agent.sessions.size, 0);
  assert.equal(calls.length, 0, "a missing boundary must never start Local Amp");
});

test("loadSession restores the Orb boundary before continuing", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit("T-orb"), success("T-orb")]);
  const store = memorySessionStore();
  const usageReports: unknown[] = [];
  store.set("S-orb", { threadId: "T-orb", executionTarget: "orb" });
  const { client } = collector();
  const agent = new AmpBridgeAgent(client, {
    execute: fn,
    store,
    orbProject: "owner/repo",
    reportExecutionUsage: (report) => void usageReports.push(report),
  });

  await agent.loadSession({
    sessionId: "S-orb",
    cwd: "/work",
    mcpServers: [{ name: "local", command: "mcp-server", args: [], env: [] }],
  });
  await agent.prompt({ sessionId: "S-orb", prompt: textPrompt("resume") });

  assert.equal(calls[0].options?.executor, "orb");
  assert.equal(calls[0].options?.continue, "T-orb");
  assert.equal(calls[0].options?.project, undefined);
  assert.equal(calls[0].options?.mcpConfig, undefined);
  assert.deepEqual(usageReports, [
    {
      sessionId: "S-orb",
      executionTarget: "orb",
      ampThreadId: "T-orb",
    },
    {
      sessionId: "S-orb",
      executionTarget: "orb",
      ampThreadId: "T-orb",
    },
  ]);
});

test("mcp servers from bb are converted and passed to execute", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { client } = collector();
  const agent = new AmpBridgeAgent(client, { execute: fn, store: memorySessionStore() });
  const session = await agent.newSession({
    cwd: "/work",
    mcpServers: [
      {
        name: "tools",
        command: "/bin/mcp",
        args: ["--serve"],
        env: [{ name: "TOKEN", value: "secret" }],
      },
    ],
  });
  await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("hi") });
  assert.deepEqual(calls[0].options?.mcpConfig, {
    tools: { command: "/bin/mcp", args: ["--serve"], env: { TOKEN: "secret" } },
  });
});

test("the first Local attempt reports its Amp thread link without showing Orb usage", async () => {
  const { fn } = scriptedExecute(() => [sysInit(), success()]);
  const usageReports: unknown[] = [];
  const { agent, sessionId } = await newAgentSession(fn, collector(), {
    reportExecutionUsage: (report) => void usageReports.push(report),
  });

  await agent.prompt({ sessionId, prompt: textPrompt("work locally") });

  assert.deepEqual(usageReports, [
    {
      sessionId,
      executionTarget: "local",
      ampThreadId: null,
    },
    {
      sessionId,
      executionTarget: "local",
      ampThreadId: THREAD,
    },
  ]);
});

test("Orb omits bb MCP without a chat note and reports its actual Amp thread", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const updates = collector();
  const usageReports: unknown[] = [];
  const agent = new AmpBridgeAgent(updates.client, {
    execute: fn,
    store: memorySessionStore(),
    oracleReports: stubOracleReports(),
    reportExecutionUsage: (report) => void usageReports.push(report),
  });
  const session = await agent.newSession({
    cwd: "/work",
    mcpServers: [{ name: "selected-tools", command: "mcp-server", args: [], env: [] }],
  });

  await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("one /orb") });
  await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("two") });

  const notes = updates.updates.filter((notification) => {
    const content = (notification.update as { content?: { text?: string } }).content;
    return content?.text?.includes("Amp Orb uses") || content?.text?.includes("bb-selected tools");
  });
  assert.equal(notes.length, 0);
  assert.equal(calls[0].options?.mcpConfig, undefined);
  assert.equal(calls[1].options?.mcpConfig, undefined);
  assert.deepEqual(usageReports, [
    {
      sessionId: session.sessionId,
      executionTarget: "orb",
      ampThreadId: null,
    },
    {
      sessionId: session.sessionId,
      executionTarget: "orb",
      ampThreadId: THREAD,
    },
    {
      sessionId: session.sessionId,
      executionTarget: "orb",
      ampThreadId: THREAD,
    },
  ]);
});

test("convertMcpServers handles remote transports and skips acp ones", () => {
  const config = convertMcpServers([
    {
      type: "http",
      name: "remote",
      url: "https://mcp.example",
      headers: [{ name: "a", value: "b" }],
    },
    { type: "sse", name: "legacy", url: "https://legacy.example/sse", headers: [] },
    { type: "acp", name: "skip-me" },
  ] as never);
  assert.deepEqual(config, {
    remote: { url: "https://mcp.example", headers: { a: "b" }, transport: undefined },
    legacy: { url: "https://legacy.example/sse", headers: undefined, transport: "sse" },
  });
});

test("reports MCP servers needing attention once per session", async () => {
  const { fn } = scriptedExecute(() => [
    {
      ...sysInit(),
      mcp_servers: [
        { name: "healthy", status: "connected" },
        { name: "warming", status: "connecting" },
        { name: "github", status: "awaiting-approval" },
        { name: "database", status: "failed" },
      ],
    },
    success(),
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);

  await agent.prompt({ sessionId, prompt: textPrompt("one") });
  await agent.prompt({ sessionId, prompt: textPrompt("two") });

  const warnings = updates.updates.filter((notification) => {
    const content = (notification.update as { content?: { text?: string } }).content;
    return content?.text?.startsWith("Amp MCP servers need attention:");
  });
  assert.equal(warnings.length, 1);
  const text = (warnings[0].update as { content: { text: string } }).content.text;
  assert.match(text, /github \(awaiting approval\)/);
  assert.match(text, /database \(failed\)/);
  assert.doesNotMatch(text, /healthy|warming/);
});

test("a turn that ends without a thread id emits an unlinked-thread notice", async () => {
  const { fn } = scriptedExecute(() => [
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      },
    },
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  const response = await agent.prompt({ sessionId, prompt: textPrompt("x") });
  assert.equal(response.stopReason, "end_turn");
  const notice = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text?.includes("could not be linked to an Amp thread");
  });
  assert.ok(notice, "expected an unlinked-thread notice");
});

test("failed tool_result maps to status failed with code-fenced content", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant([{ type: "tool_use", id: "tu-err", name: "Bash", input: { cmd: "explode" } }]),
    userMsg([{ type: "tool_result", tool_use_id: "tu-err", content: "boom", is_error: true }]),
    success(),
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);

  const response = await agent.prompt({ sessionId, prompt: textPrompt("fail a tool") });
  assert.equal(response.stopReason, "end_turn");
  const toolUpdate = updates.updates
    .map((n) => n.update as Record<string, unknown>)
    .find((u) => u.sessionUpdate === "tool_call_update");
  assert.ok(toolUpdate, "expected a tool_call_update");
  assert.equal(toolUpdate.toolCallId, "tu-err");
  assert.equal(toolUpdate.status, "failed");
  const content = toolUpdate.content as { content: { text: string } }[];
  assert.equal(content[0].content.text, "```\nboom\n```");
});

test("Oracle emits its card at start and captures nested progress before completion", async () => {
  const oracleResponse = "## Recommendation\n\nKeep the protocol seam. ✓";
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant([
      { type: "tool_use", id: "tu-oracle", name: "oracle", input: { task: "Review it" } },
    ]),
    {
      ...assistant([{ type: "thinking", thinking: "Inspecting the implementation" }]),
      parent_tool_use_id: "tu-oracle",
    },
    {
      ...assistant([
        { type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "src/a.ts" } },
      ]),
      parent_tool_use_id: "tu-oracle",
    },
    {
      ...userMsg([
        {
          type: "tool_result",
          tool_use_id: "tu-read",
          content: "source",
          is_error: false,
        },
      ]),
      parent_tool_use_id: "tu-oracle",
    },
    userMsg([
      {
        type: "tool_result",
        tool_use_id: "tu-oracle",
        content: oracleResponse,
        is_error: false,
      },
    ]),
    assistant([{ type: "text", text: "Follow-up analysis." }]),
    success(),
  ]);
  const updates = collector();
  const started: unknown[] = [];
  const appended: Array<{ reportId: string; event: OracleTraceEventInput }> = [];
  const completed: Array<{ reportId: string; content: unknown; isError: boolean }> = [];
  const agent = new AmpBridgeAgent(updates.client, {
    execute: fn,
    store: memorySessionStore(),
    oracleReports: {
      start(input) {
        started.push(input);
        return "11111111-1111-4111-8111-111111111111";
      },
      append(reportId, event) {
        appended.push({ reportId, event });
        return true;
      },
      complete(reportId, content, isError) {
        completed.push({ reportId, content, isError });
        return true;
      },
    },
  });
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });
  const sessionId = session.sessionId;

  await agent.prompt({ sessionId, prompt: textPrompt("ask Oracle") });

  assert.deepEqual(started, [{ task: "Review it" }]);
  assert.deepEqual(
    appended.map(({ event }) => [event.kind, event.status]),
    [
      ["thinking", undefined],
      ["tool", "running"],
      ["tool", "completed"],
    ],
  );
  assert.deepEqual(completed, [
    {
      reportId: "11111111-1111-4111-8111-111111111111",
      content: oracleResponse,
      isError: false,
    },
  ]);

  const directiveUpdate = updates.updates
    .map((notification) => notification.update as Record<string, unknown>)
    .find((update) => {
      const content = update.content as { text?: string } | undefined;
      return (
        update.sessionUpdate === "agent_message_chunk" && content?.text?.includes("::amp-oracle{")
      );
    });
  const directive = (directiveUpdate?.content as { text?: string } | undefined)?.text;
  assert.equal(directive, '\n\n::amp-oracle{reportId="11111111-1111-4111-8111-111111111111"}\n\n');
  const textChunks = updates.updates
    .map(
      (notification) =>
        notification.update as { sessionUpdate?: string; content?: { text?: string } },
    )
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => update.content?.text);
  assert.deepEqual(textChunks.slice(-2), [directive, "Follow-up analysis."]);

  const directiveIndex = updates.updates.findIndex((notification) => {
    const update = notification.update as { sessionUpdate?: string; content?: { text?: string } };
    return (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.text?.includes("::amp-oracle{") === true
    );
  });
  const oracleCompleteIndex = updates.updates.findIndex((notification) => {
    const update = notification.update as Record<string, unknown>;
    return update.sessionUpdate === "tool_call_update" && update.toolCallId === "tu-oracle";
  });
  assert.ok(directiveIndex < oracleCompleteIndex, "the card must render before Oracle finishes");

  const toolUpdate = updates.updates
    .map((notification) => notification.update as Record<string, unknown>)
    .find(
      (update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "tu-oracle",
    );
  assert.equal(
    toolUpdate?.toolCallId,
    "tu-oracle",
    "the native tool row remains available as fallback",
  );
});

test("an interrupted Oracle report stops running when its turn ends", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant([
      { type: "tool_use", id: "tu-oracle-open", name: "oracle", input: { task: "Review it" } },
    ]),
    success(),
  ]);
  const updates = collector();
  const completed: Array<{ content: unknown; isError: boolean }> = [];
  const agent = new AmpBridgeAgent(updates.client, {
    execute: fn,
    store: memorySessionStore(),
    oracleReports: {
      ...stubOracleReports(),
      complete(_reportId, content, isError) {
        completed.push({ content, isError });
        return true;
      },
    },
  });
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });

  await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("ask Oracle") });

  assert.deepEqual(completed, [
    {
      content: "Oracle execution ended before returning a result.",
      isError: true,
    },
  ]);
});

test("assistant and tool-result images map to valid ACP content", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant([
      {
        type: "image",
        source: { type: "base64", data: "aW1hZ2U=", media_type: "image/png" },
      },
      { type: "tool_use", id: "tu-image", name: "view_media", input: { path: "chart.png" } },
    ]),
    userMsg([
      {
        type: "tool_result",
        tool_use_id: "tu-image",
        is_error: false,
        content: [
          {
            type: "image",
            source: { type: "base64", data: "dG9vbCBpbWFnZQ==", media_type: "IMAGE/WEBP" },
          },
          { type: "image", source: { type: "url", url: "https://example.com/chart.png" } },
          {
            type: "image",
            source: { type: "base64", data: "not base64!", media_type: "image/png" },
          },
        ],
      },
    ]),
    success(),
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);

  await agent.prompt({ sessionId, prompt: textPrompt("show it") });

  const imageChunk = updates.updates
    .map((notification) => notification.update as Record<string, unknown>)
    .find((update) => update.sessionUpdate === "agent_message_chunk");
  assert.deepEqual(imageChunk?.content, {
    type: "image",
    data: "aW1hZ2U=",
    mimeType: "image/png",
  });
  const toolUpdate = updates.updates
    .map((notification) => notification.update as Record<string, unknown>)
    .find((update) => update.sessionUpdate === "tool_call_update");
  assert.deepEqual(toolUpdate?.content, [
    {
      type: "content",
      content: {
        type: "image",
        data: "dG9vbCBpbWFnZQ==",
        mimeType: "image/webp",
      },
    },
    {
      type: "content",
      content: {
        type: "resource_link",
        uri: "https://example.com/chart.png",
        name: "Image",
      },
    },
  ]);
});

test("execute throwing a generic error rejects the prompt", async () => {
  const execute: AmpExecuteFn = () =>
    (async function* (): AsyncGenerator<AmpStreamMessage> {
      throw new Error("kaboom");
    })();
  const { agent, sessionId } = await newAgentSession(execute);
  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("x") }),
    (error: Error) => error.message === "kaboom",
  );
});

test("execute throwing an auth-looking error appends the amp login hint", async () => {
  const execute: AmpExecuteFn = () =>
    (async function* (): AsyncGenerator<AmpStreamMessage> {
      throw new Error("401 unauthorized");
    })();
  const { agent, sessionId } = await newAgentSession(execute);
  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("x") }),
    (error: Error) =>
      error.message.includes("401 unauthorized") && error.message.includes("amp login"),
  );
});

test("system execution errors soft-fail after surfacing an error chunk", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    {
      type: "system",
      subtype: "error_during_execution",
      error: "cli exploded",
      session_id: THREAD,
    },
    success(),
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  const response = await agent.prompt({ sessionId, prompt: textPrompt("x") });
  assert.equal(response.stopReason, "end_turn");
  const errorChunk = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text === "Error: cli exploded";
  });
  assert.ok(errorChunk, "expected an Error: cli exploded chunk");
});

test("non-error_during_execution system errors still reject", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    { type: "system", subtype: "error", error: "unknown system failure", session_id: THREAD },
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("x") }),
    /unknown system failure/,
  );
  const errorChunk = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text === "Error: unknown system failure";
  });
  assert.ok(errorChunk, "expected an Error: unknown system failure chunk");
});

test("auth-looking system errors still reject with the amp login hint", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    {
      type: "system",
      subtype: "error_during_execution",
      error: "Invalid or missing API key",
      session_id: THREAD,
    },
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  await assert.rejects(agent.prompt({ sessionId, prompt: textPrompt("x") }), /amp login/);
  const chunk = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text?.includes("amp login");
  });
  assert.ok(chunk, "expected an auth hint chunk");
});

test("empty text and thinking blocks emit no notifications", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant(""),
    assistant([
      { type: "text", text: "" },
      { type: "thinking", thinking: "" },
    ]),
    success(),
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  const response = await agent.prompt({ sessionId, prompt: textPrompt("quiet") });
  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(updates.updates, []);
});

test("prompt flattens resource_link and embedded resource blocks", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn);
  await agent.prompt({
    sessionId,
    prompt: [
      { type: "text", text: "look at" },
      { type: "resource_link", uri: "file:///work/a.ts", name: "a.ts" },
      { type: "resource", resource: { uri: "file:///work/b.ts", text: "const b = 1;" } },
    ],
  });
  assert.ok(calls[0].prompt.includes("look at"));
  assert.ok(calls[0].prompt.includes("\nfile:///work/a.ts\n"));
  assert.ok(
    calls[0].prompt.includes('<context ref="file:///work/b.ts">\nconst b = 1;\n</context>'),
  );
});

test("a failing client.sessionUpdate does not abort the prompt stream", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant([{ type: "text", text: "one" }]),
    assistant([{ type: "text", text: "two" }]),
    success(),
  ]);
  let attempts = 0;
  const client = {
    sessionUpdate: async () => {
      attempts += 1;
      throw new Error("client broke");
    },
  };
  const agent = new AmpBridgeAgent(client, { execute: fn, store: memorySessionStore() });
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });
  const response = await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("go") });
  assert.equal(response.stopReason, "end_turn");
  assert.equal(attempts, 2, "both chunks should still be attempted");
});

test("permission denials on a successful result are reported to the user", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant([{ type: "text", text: "partial" }]),
    success(THREAD, { permission_denials: ["Bash"] }),
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  const response = await agent.prompt({ sessionId, prompt: textPrompt("do it") });
  assert.equal(response.stopReason, "end_turn");
  const denialChunk = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text?.includes("denied tool calls");
  });
  assert.ok(denialChunk, "expected a permission-denial notice");
});

test("maps SDK-generated CLI flags back to the bridge options that produce them", () => {
  assert.equal(unsupportedOptionFrom("error: unknown option '--mcp-config'"), "mcpConfig");
  assert.equal(
    unsupportedOptionFrom("error: unknown option ‘--settings-file’"),
    "dangerouslyAllowAll",
  );
  assert.equal(unsupportedOptionFrom("error: unknown option '--orb-execute'"), null);
  assert.equal(unsupportedOptionFrom("error: unknown option '--project'"), null);
});

test("Orb execution fails closed when the CLI rejects its executor flag", async () => {
  const calls: (AmpExecuteOptions | undefined)[] = [];
  const execute: AmpExecuteFn = ({ options }) => {
    calls.push(options);
    return (async function* (): AsyncGenerator<AmpStreamMessage> {
      throw new Error("error: unknown option '--orb-execute'");
    })();
  };
  const { agent, sessionId } = await newAgentSession(execute);

  await assert.rejects(
    agent.prompt({ sessionId, prompt: textPrompt("go /orb") }),
    /unknown option '--orb-execute'/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executor, "orb");
});

test("an older CLI rejecting --mcp-config retries without MCP configuration", async () => {
  const calls: (AmpExecuteOptions | undefined)[] = [];
  const execute: AmpExecuteFn = ({ options }) => {
    const index = calls.push(options) - 1;
    return (async function* (): AsyncGenerator<AmpStreamMessage> {
      if (index === 0) throw new Error("error: unknown option '--mcp-config'");
      yield sysInit();
      yield success();
    })();
  };
  const { client } = collector();
  const agent = new AmpBridgeAgent(client, { execute, store: memorySessionStore() });
  const session = await agent.newSession({
    cwd: "/work",
    mcpServers: [{ name: "local", command: "mcp-server", args: [], env: [] }],
  });

  await agent.prompt({ sessionId: session.sessionId, prompt: textPrompt("go") });

  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.mcpConfig);
  assert.equal(calls[1]?.mcpConfig, undefined);
});

test("an older CLI rejecting --settings-file retries without permission bypass", async () => {
  const calls: (AmpExecuteOptions | undefined)[] = [];
  const execute: AmpExecuteFn = ({ options }) => {
    const index = calls.push(options) - 1;
    return (async function* (): AsyncGenerator<AmpStreamMessage> {
      if (index === 0) throw new Error("error: unknown option '--settings-file'");
      yield sysInit();
      yield success();
    })();
  };
  const { agent, sessionId } = await newAgentSession(execute);
  await agent.setSessionConfigOption({
    sessionId,
    configId: CONFIG_PERMISSION,
    value: "bypass",
  });

  await agent.prompt({ sessionId, prompt: textPrompt("go") });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.dangerouslyAllowAll, true);
  assert.equal(calls[1]?.dangerouslyAllowAll, undefined);
});

test("mode labels carry Amp's models and effort as a bb-splittable dim badge", async () => {
  // bb renders a trailing parenthesised group dimmed beside the name, the
  // mechanism behind Claude Code's "Opus 5 (1M)" -> `Opus 5 1M`.
  const bbSplit = (label: string) => {
    const m = label.match(/^(.*\S)\s*\(([^()]+)\)$/u);
    return m ? { base: m[1], tag: m[2] } : { base: label, tag: null };
  };
  const { session } = await newAgentSession(scriptedExecute(() => []).fn);
  const mode = (session.configOptions ?? []).find((o) => o.id === CONFIG_MODE) as
    | { options: { value: string; name: string }[] }
    | undefined;
  const split = Object.fromEntries((mode?.options ?? []).map((o) => [o.value, bbSplit(o.name)]));
  assert.deepEqual(split.low, { base: "Low", tag: "GPT 5.6 Terra [low] · GPT 5.6 Sol [high]" });
  assert.deepEqual(split.medium, {
    base: "Medium",
    tag: "GPT 5.6 Sol [medium] · GPT 5.6 Sol [high]",
  });
  assert.deepEqual(split.high, { base: "High", tag: "GPT 5.6 Sol [x-high] · GPT 5.6 Sol [high]" });
  assert.deepEqual(split.ultra, { base: "Ultra", tag: "Fable 5 [high] · GPT 5.6 Sol [high]" });

  for (const option of mode?.options ?? []) {
    const tag = bbSplit(option.name).tag;
    assert.ok(tag, `${option.value} must expose a badge`);
    assert.equal(/[()]/.test(tag), false, "a badge containing parens would not split");
    assert.equal((tag.match(/\[[^\]]+\]/gu) ?? []).length, 2, "each effort must be bracketed");
  }
});

test("mode values stay the plain ids bb and the CLI use", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId, session } = await newAgentSession(fn);
  const mode = (session.configOptions ?? []).find((o) => o.id === CONFIG_MODE) as
    | { currentValue: string; options: { value: string }[] }
    | undefined;
  assert.deepEqual(
    mode?.options.map((o) => o.value),
    ["low", "medium", "high", "ultra"],
  );
  assert.equal(mode?.currentValue, "medium");
  await agent.setSessionConfigOption({ sessionId, configId: CONFIG_MODE, value: "ultra" });
  await agent.prompt({ sessionId, prompt: textPrompt("go") });
  assert.equal(calls[0].options?.mode, "ultra", "the CLI gets the id, never the label");
});
