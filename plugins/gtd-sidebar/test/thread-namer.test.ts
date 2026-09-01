import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createThreadNamer } from "../thread-namer.ts";

const THREAD_ID = "thr_target";

function requested(seq = 1) {
  return {
    id: `evt_${seq}`,
    seq,
    threadId: THREAD_ID,
    createdAt: seq,
    scope: { kind: "thread" as const },
    type: "client/turn/requested" as const,
    data: {
      direction: "outbound" as const,
      requestId: `req_${seq}`,
      source: "tell" as const,
      initiator: "user" as const,
      senderThreadId: null,
      input: [{ type: "text" as const, text: "Fix the login test", mentions: [] }],
      target: { kind: "thread-start" as const },
      request: { method: "thread/start" as const, params: {} },
      execution: {
        model: "claude-opus-5",
        serviceTier: "fast" as const,
        reasoningLevel: "high" as const,
        permissionMode: "full" as const,
        source: "client/turn/requested" as const,
      },
    },
  };
}

function completed(seq = 2) {
  return {
    id: `evt_${seq}`,
    seq,
    threadId: THREAD_ID,
    createdAt: seq,
    scope: { kind: "turn" as const, turnId: "turn_1" },
    type: "turn/completed" as const,
    data: {
      status: "completed" as const,
      error: null,
      providerMetadata: null,
      usage: null,
    },
  };
}

function createHost(
  options: {
    automatic?: boolean;
    events?: readonly unknown[];
    rereadTitle?: string | null;
    title?: string | null;
    archivedAt?: number | null;
    inferenceError?: Error;
    inferenceOutput?: string;
  } = {},
) {
  let getCount = 0;
  const updates: unknown[] = [];
  const inferenceCalls: unknown[] = [];
  const thread = makeThreadResponse({
    id: THREAD_ID,
    projectId: "proj_1",
    environmentId: "env_1",
    providerId: "claude",
    title: options.title ?? null,
    archivedAt: options.archivedAt ?? null,
  });
  const host = createFakePluginHost({
    pluginId: "gtd-sidebar",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          assert.equal(threadId, THREAD_ID);
          getCount += 1;
          return getCount > 1 && options.rereadTitle !== undefined
            ? { ...thread, title: options.rereadTitle }
            : thread;
        },
        events: {
          list: async () => options.events ?? [requested(), completed()],
        },
        update: async (args: unknown) => {
          updates.push(args);
          return thread;
        },
      },
    },
  });
  const namer = createThreadNamer(host.bb, {
    automaticallyNameThreads: async () => options.automatic ?? true,
    inference: {
      async complete(input) {
        inferenceCalls.push(input);
        if (options.inferenceError !== undefined) throw options.inferenceError;
        return options.inferenceOutput ?? "Fix the login test";
      },
    },
  });

  return { inferenceCalls, namer, updates };
}

describe("createThreadNamer", () => {
  test("names an untitled thread after its first completed turn", async () => {
    const { namer, updates } = createHost();

    const result = await namer.nameThread(THREAD_ID, { kind: "automatic" });

    assert.deepEqual(result, { ok: true, title: "Fix the login test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the login test" }]);
  });

  test("gates automatic naming on exactly one completed turn", async () => {
    for (const events of [[requested()], [requested(), completed(), completed(3)]]) {
      const { inferenceCalls, namer, updates } = createHost({ events });

      const result = await namer.nameThread(THREAD_ID, { kind: "automatic" });

      assert.equal(result.ok, false);
      assert.equal(inferenceCalls.length, 0);
      assert.equal(updates.length, 0);
    }
  });

  test("keeps a manual title written while automatic naming runs", async () => {
    const { namer, updates } = createHost({ rereadTitle: "My title" });

    const result = await namer.nameThread(THREAD_ID, { kind: "automatic" });

    assert.equal(result.ok, false);
    assert.equal(updates.length, 0);
  });

  test("sends the title prompt through inference without spawning a thread", async () => {
    const { inferenceCalls, namer } = createHost();

    await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.equal(inferenceCalls.length, 1);
    const call = inferenceCalls[0] as { environmentId: string; prompt: string };
    assert.equal(call.environmentId, "env_1");
    assert.match(call.prompt, /User prompt:\nFix the login test$/u);
  });

  test("forced naming replaces an archived hand title", async () => {
    const { namer, updates } = createHost({ archivedAt: 1, title: "Hand title" });

    const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.deepEqual(result, { ok: true, title: "Fix the login test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the login test" }]);
  });

  test("reports inference failures without changing the title", async () => {
    const { namer, updates } = createHost({ inferenceError: new Error("inference unavailable") });

    const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.deepEqual(result, { ok: false, error: "inference unavailable" });
    assert.equal(updates.length, 0);
  });
});
