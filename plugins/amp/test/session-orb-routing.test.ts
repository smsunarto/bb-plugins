// Session-level Orb routing: the guards restored from the ACP bridge (the
// native migration dropped them in 3607ed7), driven through createAmpSession
// with fake deps. Runner internals stay out of scope; these tests pin which
// runner a prompt reaches and what the refusals say.
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

const LATE_ORB_REFUSAL =
  "This Amp thread already runs Local and cannot switch to Orb. Start a new bb thread and include /orb in its first prompt.";

interface ThreadLinkDelta {
  kind: string;
  payload?: {
    ampThreadId: string | null;
    executionTarget: string;
    syncCommand: string | null;
  };
}

async function* oneTurn(ampThreadId: string): AsyncGenerator<AmpEventBatch> {
  yield { ampThreadId, terminal: true, events: [] };
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

function harness() {
  const deltas: ThreadLinkDelta[] = [];
  const failures: string[] = [];
  const writes: AmpSessionRecord[] = [];
  const localSends: string[] = [];
  const orbPrompts: string[] = [];

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
      createConversation: () => fakeConversation(localSends),
      runOrb: (runArgs) => {
        orbPrompts.push(runArgs.prompt);
        return {
          batches: () => oneTurn("T-orb-1"),
          abort: () => {},
        } as unknown as OrbRun;
      },
      threadCommand: () => Promise.resolve({ ok: true, stderr: "" }),
      oracle: null as unknown as OracleReports,
    },
  });

  return { session, record, deltas, failures, writes, localSends, orbPrompts };
}

function turn(text: string): TurnStartArgs {
  return {
    input: [{ type: "text", text }],
    clientRequestId: null,
    options: {} as BridgeExecutionOptions,
  };
}

test("/orb in the first prompt flips the thread to Orb and runs there", async () => {
  const h = harness();
  await h.session.startTurn(turn("/orb do the thing"));

  assert.deepEqual(h.failures, []);
  assert.equal(h.localSends.length, 0);
  assert.equal(h.orbPrompts.length, 1);
  assert.equal(h.orbPrompts[0]?.trim(), "do the thing");
  assert.equal(h.record.executionTarget, "orb");
  assert.equal(h.writes[0]?.executionTarget, "orb");

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

test("a directive-only /orb prompt fails the turn without executing", async () => {
  const h = harness();
  await h.session.startTurn(turn("/orb"));

  assert.deepEqual(h.failures, ["Add instructions to the prompt with the /orb directive"]);
  assert.equal(h.orbPrompts.length, 0);
  assert.equal(h.localSends.length, 0);
  assert.equal(h.record.executionTarget, "local");

  // The refused turn never launched, so a corrected prompt still flips.
  await h.session.startTurn(turn("/orb do the thing"));
  assert.equal(h.orbPrompts.length, 1);
  assert.equal(h.record.executionTarget, "orb");
});

test("a late /orb cannot move a thread that already ran Local", async () => {
  const h = harness();
  await h.session.startTurn(turn("hello"));
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.localSends, ["hello"]);

  await h.session.startTurn(turn("/orb and now remotely"));
  assert.deepEqual(h.failures, [LATE_ORB_REFUSAL]);
  assert.equal(h.orbPrompts.length, 0);
  assert.equal(h.record.executionTarget, "local");
});

test("later Orb turns keep running Orb without the token", async () => {
  const h = harness();
  await h.session.startTurn(turn("/orb start here"));
  await h.session.startTurn(turn("continue"));

  assert.deepEqual(h.failures, []);
  assert.equal(h.localSends.length, 0);
  assert.equal(h.orbPrompts.length, 2);
  assert.equal(h.orbPrompts[1], "continue");
});
