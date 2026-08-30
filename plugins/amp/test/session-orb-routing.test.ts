// Session-level Orb routing driven through createAmpSession with fake deps.
// The execution target is fixed on the record before the session exists:
// the bridge entry consumes the composer's armed Orb intent at thread/start
// (entry.ts). These tests pin which runner a record's turns reach and what
// `amp/thread-link` announces. Runner internals stay out of scope.
import assert from "node:assert/strict";
import { test } from "bun:test";
import type { BridgeExecutionOptions } from "@get-bb/plugin-sdk/provider-bridge";
import type { AmpConversation, OrbRun } from "../src/bridge/conversation.ts";
import type { AmpEventBatch } from "../src/bridge/events.ts";
import type { OracleReports } from "../src/bridge/project.ts";
import {
  createAmpSession,
  type AmpSessionRecord,
  type SessionStore,
  type TurnStartArgs,
} from "../src/bridge/session.ts";
import type { ThreadWriter, TurnScribe } from "../src/bridge/timeline.ts";

interface ThreadLinkDelta {
  kind: string;
  payload?: {
    ampThreadId: string | null;
    executionTarget: string;
    syncCommand: string | null;
  };
}

async function* oneTurn(
  ampThreadId: string,
  onClose: () => void = () => {},
): AsyncGenerator<AmpEventBatch> {
  try {
    yield { ampThreadId, terminal: true, events: [] };
  } finally {
    onClose();
  }
}

function fakeConversation(sends: string[]): AmpConversation {
  return {
    send: (text: string) => {
      sends.push(text);
      return Promise.resolve();
    },
    batches: () => oneTurn("T-local-1"),
    ampThreadId: "T-local-1",
    committed: true,
    closed: false,
    aborted: false,
    closeInput: () => {},
    abort: () => {},
  } as unknown as AmpConversation;
}

function harness(target: "local" | "orb" = "local") {
  const deltas: ThreadLinkDelta[] = [];
  const failures: string[] = [];
  const writes: AmpSessionRecord[] = [];
  const localSends: string[] = [];
  const orbPrompts: string[] = [];
  const orbAborts: string[] = [];
  const orbOutputsClosed: string[] = [];

  const writer = {
    emit: (batch: readonly unknown[]) => {
      for (const delta of batch) deltas.push(delta as ThreadLinkDelta);
    },
    flush: () => {},
    addUsage: () => {},
    replaced: () => {},
    recovery: () => {},
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
          throw new Error("no timeline items expected in these tests");
        },
        closeItem: () => {},
        recordItem: () => {},
        progress: () => {},
        state: () => {},
        fail: (failure: { message: string }) => {
          failures.push(failure.message);
          settled = true;
        },
        settle: () => {
          settled = true;
        },
        mintKey: (family: string) => `${family}:test`,
        get settled() {
          return settled;
        },
      } as unknown as TurnScribe;
    },
  } as unknown as ThreadWriter;

  const store: SessionStore = {
    read: () => Promise.resolve(null),
    write: (_id, sessionRecord) => {
      writes.push({ ...sessionRecord });
      return Promise.resolve();
    },
    delete: () => Promise.resolve(),
  };

  const record: AmpSessionRecord = {
    ampThreadId: null,
    executionTarget: target,
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
      createConversation: () => fakeConversation(localSends),
      runOrb: (runArgs) => {
        orbPrompts.push(runArgs.prompt);
        return {
          batches: () => oneTurn("T-orb-1", () => orbOutputsClosed.push("closed")),
          abort: () => {
            orbAborts.push("aborted");
          },
        } as unknown as OrbRun;
      },
      threadCommand: () => Promise.resolve({ ok: true, stderr: "" }),
      oracle: null as unknown as OracleReports,
    },
  });

  return {
    session,
    record,
    deltas,
    failures,
    writes,
    localSends,
    orbPrompts,
    orbAborts,
    orbOutputsClosed,
  };
}

function turn(text: string): TurnStartArgs {
  return {
    input: [{ type: "text", text }],
    clientRequestId: null,
    options: {} as BridgeExecutionOptions,
  };
}

test("an orb record routes every turn to runOrb and never touches Local", async () => {
  const h = harness("orb");
  await h.session.startTurn(turn("do the thing"));
  await h.session.startTurn(turn("continue"));

  assert.deepEqual(h.failures, []);
  assert.equal(h.localSends.length, 0);
  assert.deepEqual(h.orbPrompts, ["do the thing", "continue"]);
  assert.equal(h.orbAborts.length, 2);
  assert.equal(h.orbOutputsClosed.length, 2);
  assert.equal(h.record.ampThreadId, "T-orb-1");
  assert.equal(h.writes[0]?.ampThreadId, "T-orb-1");
});

test("an orb record announces the starting banner, then the sync command", async () => {
  const h = harness("orb");
  await h.session.startTurn(turn("do the thing"));

  const links = h.deltas.filter((delta) => delta.kind === "extension.state");
  assert.deepEqual(links[0]?.payload, {
    ampThreadId: null,
    executionTarget: "orb",
    syncCommand: null,
  });
  assert.deepEqual(links.at(-1)?.payload, {
    ampThreadId: "T-orb-1",
    executionTarget: "orb",
    syncCommand: "amp sync T-orb-1",
  });
});

test("a local record routes turns to the local conversation", async () => {
  const h = harness();
  await h.session.startTurn(turn("hello"));

  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.localSends, ["hello"]);
  assert.equal(h.orbPrompts.length, 0);

  const links = h.deltas.filter((delta) => delta.kind === "extension.state");
  assert.deepEqual(links.at(-1)?.payload, {
    ampThreadId: "T-local-1",
    executionTarget: "local",
    syncCommand: null,
  });
});
