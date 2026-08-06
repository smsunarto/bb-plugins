import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  AmpBridgeAgent,
  convertMcpServers,
  memorySessionStore,
  CONFIG_MODE,
  CONFIG_PERMISSION,
  type AmpExecuteFn,
  type AmpExecuteOptions,
} from "../src/bridge-core.ts";
import type { AmpStreamMessage } from "../src/translate.ts";

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

function userMsg(content: unknown, threadId = THREAD): AmpStreamMessage {
  return { type: "user", session_id: threadId, message: { content } as { content: unknown } };
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

function scriptedExecute(
  script: (call: RecordedCall, index: number) => AmpStreamMessage[],
): { fn: AmpExecuteFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: AmpExecuteFn = ({ prompt, options, signal }) => {
    const call = { prompt, options };
    calls.push(call);
    const messages = script(call, calls.length - 1);
    return (async function* () {
      for (const message of messages) {
        signal?.throwIfAborted();
        yield message;
      }
    })();
  };
  return { fn, calls };
}

function collector(): { updates: SessionNotification[]; client: { sessionUpdate: (n: SessionNotification) => Promise<void> } } {
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

async function newAgentSession(execute: AmpExecuteFn, updates = collector()) {
  const agent = new AmpBridgeAgent(updates.client, { execute, store: memorySessionStore() });
  const session = await agent.newSession({ cwd: "/work", mcpServers: [] });
  return { agent, sessionId: session.sessionId, session, updates };
}

const textPrompt = (text: string) => [{ type: "text" as const, text }];

test("initialize advertises protocol 1, loadSession, and no image support", async () => {
  const { agent } = await newAgentSession(scriptedExecute(() => []).fn);
  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  assert.equal(response.protocolVersion, 1);
  assert.equal(response.agentCapabilities?.loadSession, true);
  assert.equal(response.agentCapabilities?.promptCapabilities?.image, false);
  assert.equal(response.authMethods, undefined);
});

test("newSession exposes only the model and permission config options", async () => {
  const { session } = await newAgentSession(scriptedExecute(() => []).fn);
  const options = session.configOptions ?? [];
  const byId = new Map(options.map((option) => [option.id, option]));
  assert.equal(byId.get(CONFIG_MODE)?.category, "model");
  assert.equal(byId.get(CONFIG_MODE)?.currentValue, "medium");
  // No thought_level option: Amp owns model and effort selection.
  assert.equal(options.some((option) => option.category === "thought_level"), false);
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
    userMsg([
      { type: "tool_result", tool_use_id: "tu-1", content: "file.txt", is_error: false },
    ]),
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
  assert.equal(calls[0].options?.dangerouslyAllowAll, undefined);

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

test("captures the Amp thread id and continues it on the next prompt", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), assistant([{ type: "text", text: "ok" }]), success()]);
  const { agent, sessionId } = await newAgentSession(fn);

  await agent.prompt({ sessionId, prompt: textPrompt("one") });
  await agent.prompt({ sessionId, prompt: textPrompt("two") });

  assert.equal(calls[0].options?.continue, undefined);
  assert.equal(calls[1].options?.continue, THREAD);
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

test("error result surfaces an error chunk; max turns maps to max_turn_requests", async () => {
  const { fn } = scriptedExecute((_call, index) => [
    sysInit(),
    index === 0
      ? { type: "result", subtype: "error_during_execution", is_error: true, error: "boom", session_id: THREAD }
      : { type: "result", subtype: "error_max_turns", is_error: true, error: "too many turns", session_id: THREAD },
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
});

test("auth-looking result errors carry an amp login hint", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    { type: "result", subtype: "error_during_execution", is_error: true, error: "Invalid or missing API key", session_id: THREAD },
  ]);
  const updates = collector();
  const { agent, sessionId } = await newAgentSession(fn, updates);
  await agent.prompt({ sessionId, prompt: textPrompt("x") });
  const chunk = updates.updates.find((n) => {
    const content = (n.update as { content?: { text?: string } }).content;
    return content?.text?.includes("amp login");
  });
  assert.ok(chunk, "expected an auth hint chunk");
});

test("config option changes flow into the next execute options", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId } = await newAgentSession(fn);

  const afterMode = await agent.setSessionConfigOption({ sessionId, configId: CONFIG_MODE, value: "high" });
  const modeOption = afterMode.configOptions.find((o) => o.id === CONFIG_MODE);
  assert.equal(modeOption?.currentValue, "high");
  await agent.setSessionConfigOption({ sessionId, configId: CONFIG_PERMISSION, value: "bypass" });

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

test("loadSession resumes the stored Amp thread; unknown sessions throw", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const store = memorySessionStore();
  store.set("S-restored", "T-earlier");
  const { client } = collector();
  const agent = new AmpBridgeAgent(client, { execute: fn, store });

  const loaded = await agent.loadSession({ sessionId: "S-restored", cwd: "/work", mcpServers: [] });
  assert.ok(loaded.configOptions && loaded.configOptions.length > 0);
  await agent.prompt({ sessionId: "S-restored", prompt: textPrompt("resume") });
  assert.equal(calls[0].options?.continue, "T-earlier");

  await assert.rejects(
    agent.loadSession({ sessionId: "S-unknown", cwd: "/work", mcpServers: [] }),
    /no Amp thread recorded/,
  );
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

test("convertMcpServers handles http servers and skips acp ones", () => {
  const config = convertMcpServers([
    { type: "http", name: "remote", url: "https://mcp.example", headers: [{ name: "a", value: "b" }] },
    { type: "acp", name: "skip-me" },
  ] as never);
  assert.deepEqual(config, { remote: { url: "https://mcp.example", headers: { a: "b" } } });
});

test("a turn that ends without a thread id emits an unlinked-thread notice", async () => {
  const { fn } = scriptedExecute(() => [
    { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
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
    (error: Error) => error.message.includes("401 unauthorized") && error.message.includes("amp login"),
  );
});

test("system-type error messages surface as error chunks", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    { type: "system", subtype: "error", error: "cli exploded", session_id: THREAD },
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

test("empty text and thinking blocks emit no notifications", async () => {
  const { fn } = scriptedExecute(() => [
    sysInit(),
    assistant(""),
    assistant([{ type: "text", text: "" }, { type: "thinking", thinking: "" }]),
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
  assert.ok(calls[0].prompt.includes('<context ref="file:///work/b.ts">\nconst b = 1;\n</context>'));
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















test("mode labels carry Amp's model as a bb-splittable dim badge", async () => {
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
  const split = Object.fromEntries(
    (mode?.options ?? []).map((o) => [o.value, bbSplit(o.name)]),
  );
  assert.deepEqual(split.low, { base: "Low", tag: "GLM 5.2 · GPT 5.6 Sol" });
  assert.deepEqual(split.medium, { base: "Medium", tag: "GPT 5.6 Sol · GPT 5.6 Sol" });
  assert.deepEqual(split.high, { base: "High", tag: "GPT 5.6 Sol · Fable 5" });
  assert.deepEqual(split.ultra, { base: "Ultra", tag: "Fable 5 · GPT 5.6 Sol" });

  for (const option of mode?.options ?? []) {
    const tag = bbSplit(option.name).tag;
    assert.ok(tag, `${option.value} must expose a badge`);
    assert.equal(/[()]/.test(tag), false, "a badge containing parens would not split");
  }
});

test("mode values stay the plain ids bb and the CLI use", async () => {
  const { fn, calls } = scriptedExecute(() => [sysInit(), success()]);
  const { agent, sessionId, session } = await newAgentSession(fn);
  const mode = (session.configOptions ?? []).find((o) => o.id === CONFIG_MODE) as
    | { currentValue: string; options: { value: string }[] }
    | undefined;
  assert.deepEqual(mode?.options.map((o) => o.value), ["low", "medium", "high", "ultra"]);
  assert.equal(mode?.currentValue, "medium");
  await agent.setSessionConfigOption({ sessionId, configId: CONFIG_MODE, value: "ultra" });
  await agent.prompt({ sessionId, prompt: textPrompt("go") });
  assert.equal(calls[0].options?.mode, "ultra", "the CLI gets the id, never the label");
});

