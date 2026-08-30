import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import type {
  BridgeExecutionOptions,
  ProviderRecoveryHint,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AmpConversation } from "../src/bridge/conversation.ts";
import { parseAmpBatch, type AmpEventBatch } from "../src/bridge/events.ts";
import type { OracleReports } from "../src/bridge/project.ts";
import {
  createAmpSession,
  type AmpSessionRecord,
  type SessionDeps,
  type SessionStore,
  type TurnStartArgs,
} from "../src/bridge/session.ts";
import type { ThreadWriter, TurnScribe } from "../src/bridge/timeline.ts";

const SOCKET_CLOSED =
  "OpenAI WebSocket closed: 1006 . If this persists, deactivate your ChatGPT subscription: https://ampcode.com/settings/model-routing";

interface FakeConversation extends AmpConversation {
  readonly sends: string[];
  readonly abortReasons: Array<Parameters<AmpConversation["abort"]>[0]>;
  readonly outputClosed: boolean;
}

function fakeConversation(script: readonly AmpEventBatch[], streamError?: Error): FakeConversation {
  const sends: string[] = [];
  const abortReasons: Array<Parameters<AmpConversation["abort"]>[0]> = [];
  let closed = false;
  let aborted = false;
  let outputClosed = false;
  const output = (async function* (): AsyncGenerator<AmpEventBatch> {
    try {
      yield* script;
      if (streamError !== undefined) throw streamError;
    } finally {
      outputClosed = true;
    }
  })();

  return {
    sends,
    abortReasons,
    send: (text) => {
      sends.push(text);
      return Promise.resolve();
    },
    batches: () => output,
    ampThreadId: script.at(-1)?.ampThreadId ?? null,
    committed: script.length > 0,
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
    get outputClosed() {
      return outputClosed;
    },
    closeInput: () => {
      closed = true;
    },
    abort: (reason) => {
      abortReasons.push(reason);
      aborted = true;
      closed = true;
    },
  };
}

function terminalOnAbortConversation(): {
  conversation: FakeConversation;
  waiting: Promise<void>;
} {
  const sends: string[] = [];
  const abortReasons: Array<Parameters<AmpConversation["abort"]>[0]> = [];
  let aborted = false;
  let closed = false;
  let releaseBatch: ((batch: AmpEventBatch) => void) | null = null;
  let markWaiting: (() => void) | null = null;
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  const batch = new Promise<AmpEventBatch>((resolve) => {
    releaseBatch = resolve;
  });
  const output = (async function* (): AsyncGenerator<AmpEventBatch> {
    markWaiting?.();
    yield await batch;
  })();

  return {
    waiting,
    conversation: {
      sends,
      abortReasons,
      send: (text) => {
        sends.push(text);
        return Promise.resolve();
      },
      batches: () => output,
      ampThreadId: null,
      committed: false,
      get closed() {
        return closed;
      },
      get aborted() {
        return aborted;
      },
      get outputClosed() {
        return false;
      },
      closeInput: () => {
        closed = true;
      },
      abort: (reason) => {
        abortReasons.push(reason);
        aborted = true;
        closed = true;
        releaseBatch?.({ ampThreadId: null, terminal: true, events: [] });
      },
    },
  };
}

function turn(text: string): TurnStartArgs {
  return {
    input: [{ type: "text", text }],
    clientRequestId: null,
    options: {} as BridgeExecutionOptions,
  };
}

function harness(
  conversations: FakeConversation[],
  write: SessionStore["write"] = () => Promise.resolve(),
) {
  const createConversation = mock<SessionDeps["createConversation"]>(() => {
    const conversation = conversations.shift();
    assert.ok(conversation, "unexpected extra Local conversation");
    return conversation;
  });
  const failures: Array<Parameters<TurnScribe["fail"]>[0]> = [];
  const settlements: Array<Parameters<TurnScribe["settle"]>[0]> = [];
  const replacements: unknown[] = [];
  const recoveries: ProviderRecoveryHint[] = [];
  const writer = {
    emit: () => {},
    flush: () => {},
    addUsage: () => {},
    replaced: (notice: unknown) => {
      replacements.push(notice);
    },
    recovery: (hint: ProviderRecoveryHint) => {
      recoveries.push(hint);
    },
    raw: () => {},
    scribe: (): TurnScribe => {
      let settled = false;
      return {
        accept: () => {},
        open: () => {},
        say: () => {},
        think: () => {},
        warn: () => {},
        openItem: () => {
          throw new Error("no timeline items expected in this test");
        },
        closeItem: () => {},
        recordItem: () => {},
        progress: () => {},
        state: () => {},
        fail: (failure) => {
          failures.push(failure);
          if (failure.settlesTurn) settled = true;
        },
        settle: (status) => {
          settlements.push(status);
          settled = true;
        },
        mintKey: (family) => `${family}:test`,
        get settled() {
          return settled;
        },
      } as TurnScribe;
    },
  } as ThreadWriter;
  const store: SessionStore = {
    read: () => Promise.resolve(null),
    write,
    delete: () => Promise.resolve(),
  };
  const record: AmpSessionRecord = {
    ampThreadId: null,
    executionTarget: "local",
    threadId: "thr_test",
  };
  const session = createAmpSession({
    threadId: "thr_test",
    providerThreadId: "amp-test",
    cwd: "/tmp",
    record,
    writer,
    store,
    disallowedTools: [],
    mcpConfigDigest: "",
    bbToolIds: new Set(),
    deps: {
      createConversation,
      runOrb: () => {
        throw new Error("Orb is not expected in this test");
      },
      threadCommand: () => Promise.resolve({ ok: true, stderr: "" }),
      oracle: null as unknown as OracleReports,
    },
  });

  return {
    session,
    record,
    createConversation,
    failures,
    settlements,
    replacements,
    recoveries,
  };
}

function assistantStop(ampThreadId: string): AmpEventBatch {
  return {
    ampThreadId,
    terminal: false,
    events: [{ kind: "assistantStop", reason: "end_turn" }],
  };
}

function socketDisconnect(): AmpEventBatch {
  return parseAmpBatch({
    type: "result",
    subtype: "error_during_execution",
    session_id: "T-prod",
    is_error: true,
    error: SOCKET_CLOSED,
  });
}

test("a terminal WebSocket error resumes Local with --continue and only the new prompt", async () => {
  const disconnected = socketDisconnect();
  assert.deepEqual(disconnected, {
    ampThreadId: "T-prod",
    terminal: true,
    events: [
      {
        kind: "resultError",
        subtype: "stream_disconnected",
        message: SOCKET_CLOSED,
        denials: [],
      },
    ],
  });
  const first = fakeConversation([disconnected]);
  const second = fakeConversation([assistantStop("T-prod")]);
  const h = harness([first, second]);

  await h.session.startTurn(turn("original prompt"));

  assert.deepEqual(h.failures, [
    {
      message: SOCKET_CLOSED,
      settlesTurn: true,
      category: "stream-disconnected",
      willRetry: false,
    },
  ]);
  assert.deepEqual(h.recoveries, [
    {
      kind: "restartRecommended",
      message: "Amp disconnected from OpenAI. Retry to continue this thread in a fresh process.",
      retryable: true,
    },
  ]);
  assert.equal(h.record.ampThreadId, "T-prod");
  assert.deepEqual(first.abortReasons, ["restart"]);
  assert.equal(first.outputClosed, true);

  await h.session.startTurn(turn("continue"));

  assert.equal(h.createConversation.mock.calls.length, 2);
  assert.equal(h.createConversation.mock.calls[1]?.[0].continueFrom, "T-prod");
  assert.deepEqual(first.sends, ["original prompt"]);
  assert.deepEqual(second.sends, ["continue"]);
  assert.equal(h.failures.length, 1);
  assert.deepEqual(h.replacements, [
    {
      providerThreadId: "amp-test",
      reason: "the Amp process ended",
      contextLost: false,
    },
  ]);
});

test("a nonterminal assistant stop keeps the Local conversation warm", async () => {
  const conversation = fakeConversation([assistantStop("T-warm"), assistantStop("T-warm")]);
  const h = harness([conversation]);

  await h.session.startTurn(turn("one"));
  await h.session.startTurn(turn("two"));

  assert.equal(h.createConversation.mock.calls.length, 1);
  assert.deepEqual(conversation.sends, ["one", "two"]);
  assert.deepEqual(conversation.abortReasons, []);
  assert.equal(conversation.outputClosed, false);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.settlements, ["completed", "completed"]);
});

test("natural iterator completion retires the Local conversation", async () => {
  const conversation = fakeConversation([]);
  const replacement = fakeConversation([assistantStop("T-new")]);
  const h = harness([conversation, replacement]);

  await h.session.startTurn(turn("one"));

  assert.deepEqual(h.failures, [
    { message: "Amp ended without reporting a result", settlesTurn: true },
  ]);
  assert.deepEqual(conversation.abortReasons, ["restart"]);
  assert.equal(conversation.outputClosed, true);
  assert.deepEqual(h.replacements, []);

  await h.session.startTurn(turn("two"));

  assert.deepEqual(h.replacements, [
    {
      providerThreadId: "amp-test",
      reason: "the Amp process ended",
      contextLost: true,
    },
  ]);
});

test("an iterator throw retires the Local conversation", async () => {
  const conversation = fakeConversation([], new Error("stream broke"));
  const h = harness([conversation]);

  await h.session.startTurn(turn("one"));

  assert.deepEqual(h.failures, [{ message: "Amp failed: stream broke", settlesTurn: true }]);
  assert.deepEqual(conversation.abortReasons, ["restart"]);
  assert.equal(conversation.outputClosed, true);
  assert.deepEqual(h.replacements, []);
});

test("a stream disconnect still recommends retry when the Amp thread write fails", async () => {
  const conversation = fakeConversation([socketDisconnect()]);
  const h = harness([conversation], () => Promise.reject(new Error("disk full")));

  await h.session.startTurn(turn("one"));

  assert.equal(h.record.ampThreadId, "T-prod");
  assert.deepEqual(h.recoveries, [
    {
      kind: "restartRecommended",
      message: "Amp disconnected from OpenAI. Retry to continue this thread in a fresh process.",
      retryable: true,
    },
  ]);
  assert.deepEqual(conversation.abortReasons, ["restart"]);
  assert.equal(conversation.outputClosed, true);
});

test("a failed Amp thread write is attempted only once per session", async () => {
  const write = mock<SessionStore["write"]>(() => Promise.reject(new Error("disk full")));
  const conversation = fakeConversation([
    { ampThreadId: "T-prod", terminal: false, events: [] },
    { ampThreadId: "T-prod", terminal: true, events: [] },
  ]);
  const h = harness([conversation], write);

  await h.session.startTurn(turn("one"));

  assert.equal(write.mock.calls.length, 1);
});

test("a buffered terminal batch honors release and interrupt stops", async () => {
  for (const [intent, expected] of [
    ["release", []],
    ["interrupt", ["interrupted"]],
  ] as const) {
    const { conversation, waiting } = terminalOnAbortConversation();
    const h = harness([conversation]);
    const started = h.session.startTurn(turn(intent));
    await waiting;

    await h.session.stop(intent);
    await started;

    assert.deepEqual(h.settlements, expected);
  }
});
