import assert from "node:assert/strict";
import { describe, expect, mock, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createThreadNamer, subscribeToThreadNaming } from "../thread-namer.ts";

const THREAD_ID = "thr_target";

function requested(
  seq = 1,
  text = "Fix the login test",
  target: "thread-start" | "new-turn" | "active-turn" = "thread-start",
) {
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
      input: [{ type: "text" as const, text, mentions: [] }],
      target: { kind: target },
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
    environmentPath?: string | null;
    inferenceComplete?: (input: unknown) => Promise<string | null>;
    inferenceError?: Error;
    inferenceOutput?: string | null;
    projectInstructionEncoding?: "base64" | "utf8";
    projectInstructionError?: Error;
    projectInstructions?: string;
  } = {},
) {
  let getCount = 0;
  const fileReads: unknown[] = [];
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
      environments: {
        get: async ({ environmentId }) => {
          assert.equal(environmentId, "env_1");
          return {
            id: "env_1",
            hostId: "host_1",
            path: options.environmentPath === undefined ? "/workspace" : options.environmentPath,
          };
        },
      },
      files: {
        read: async (args) => {
          fileReads.push(args);
          if (options.projectInstructionError !== undefined) {
            throw options.projectInstructionError;
          }
          if (options.projectInstructions === undefined) {
            throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
          }
          return {
            content: options.projectInstructions,
            contentEncoding: options.projectInstructionEncoding ?? "utf8",
            modifiedAtMs: 1,
            sha256: "abc",
            sizeBytes: options.projectInstructions.length,
          };
        },
      },
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
        if (options.inferenceComplete !== undefined) return options.inferenceComplete(input);
        if (options.inferenceError !== undefined) throw options.inferenceError;
        return options.inferenceOutput === undefined
          ? "Fix the login test"
          : options.inferenceOutput;
      },
    },
  });

  return { fileReads, host, inferenceCalls, namer, updates };
}

describe("createThreadNamer", () => {
  test("names an untitled thread when its first prompt arrives", async () => {
    const { namer, updates } = createHost({ events: [requested()] });

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
    });

    assert.deepEqual(result, { ok: true, title: "Fix the login test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the login test" }]);
  });

  test("names initial, follow-up, and steering prompts before completion", async () => {
    for (const events of [
      [requested()],
      [requested(), completed(), requested(3, "Now fix signup", "new-turn")],
      [requested(), requested(3, "Now fix signup", "active-turn")],
    ]) {
      const { inferenceCalls, namer, updates } = createHost({ events });

      const result = await namer.nameThread(THREAD_ID, {
        kind: "automatic",
      });

      assert.equal(result.ok, true);
      assert.equal(inferenceCalls.length, 1);
      assert.equal(updates.length, 1);
    }
  });

  test("does not read project instructions when naming will be skipped", async () => {
    const { fileReads, namer } = createHost({ automatic: false });

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(fileReads, []);
  });

  test("regenerates an existing title from the latest prompt without a handoff", async () => {
    const { inferenceCalls, namer, updates } = createHost({
      events: [requested(), completed(), requested(3, "Now fix signup", "new-turn"), completed(4)],
      inferenceOutput: "Fix the signup test",
      title: "Fix the login test",
    });

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
    });

    assert.deepEqual(result, { ok: true, title: "Fix the signup test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the signup test" }]);
    const call = inferenceCalls[0] as { prompt: string };
    assert.match(call.prompt, /Current request:\nNow fix signup/u);
    assert.doesNotMatch(call.prompt, /Latest handoff:/u);
  });

  test("replaces BB's existing title on the first user request", async () => {
    const { namer, updates, inferenceCalls } = createHost({
      title: "BB internal title",
      inferenceOutput: "GTD task title",
      events: [requested()],
    });
    assert.deepEqual(await namer.nameThread(THREAD_ID, { kind: "automatic" }), {
      ok: true,
      title: "GTD task title",
    });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "GTD task title" }]);
    assert.equal((inferenceCalls[0] as { allowKeep: boolean }).allowKeep, false);
  });

  test("rejects keep on the first user request even when BB already named it", async () => {
    const { namer, updates } = createHost({
      title: "BB internal title",
      inferenceOutput: null,
      events: [requested()],
    });
    assert.equal((await namer.nameThread(THREAD_ID, { kind: "automatic" })).ok, false);
    assert.deepEqual(updates, []);
  });

  test("first-request naming replaces a BB title that arrives during inference", async () => {
    const { namer, updates } = createHost({
      rereadTitle: "BB title arrived later",
      inferenceOutput: "GTD task title",
      events: [requested()],
    });
    assert.deepEqual(await namer.nameThread(THREAD_ID, { kind: "automatic" }), {
      ok: true,
      title: "GTD task title",
    });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "GTD task title" }]);
  });

  test("keeps the exact existing title without a write when inference says keep", async () => {
    const { namer, updates } = createHost({
      title: "[Accounts] Pool affinity",
      inferenceOutput: null,
      events: [requested(), requested(3, "add test", "new-turn")],
    });
    assert.deepEqual(await namer.nameThread(THREAD_ID, { kind: "automatic" }), {
      ok: true,
      title: "[Accounts] Pool affinity",
    });
    assert.deepEqual(updates, []);
  });

  test("rejects keep for untitled threads and explicit regeneration", async () => {
    for (const [title, kind] of [
      [null, "automatic"],
      ["Existing title", "forced"],
    ] as const) {
      const { namer, updates } = createHost({ title, inferenceOutput: null });
      assert.equal((await namer.nameThread(THREAD_ID, { kind })).ok, false);
      assert.deepEqual(updates, []);
    }
  });

  test("does not write an identical generated title", async () => {
    const { namer, updates } = createHost({ title: "Fix the login test" });
    assert.equal((await namer.nameThread(THREAD_ID, { kind: "automatic" })).ok, true);
    assert.deepEqual(updates, []);
  });

  test("reads project title instructions from the active workspace", async () => {
    const { fileReads, inferenceCalls, namer } = createHost({
      projectInstructions: "Prefix every title with API:",
    });

    const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.equal(result.ok, true);
    assert.deepEqual(fileReads, [
      {
        hostId: "host_1",
        path: "/workspace/.agents/GTD_NAMING.md",
        rootPath: "/workspace",
      },
    ]);
    const call = inferenceCalls[0] as { prompt: string };
    assert.match(call.prompt, /Project title rules:\nPrefix every title with API:/u);
  });

  test("falls back to default instructions when the project file is unusable", async () => {
    for (const options of [
      {},
      { projectInstructions: "encoded", projectInstructionEncoding: "base64" as const },
      { projectInstructionError: new Error("host unavailable") },
    ]) {
      const { inferenceCalls, namer } = createHost(options);

      const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

      assert.equal(result.ok, true);
      const call = inferenceCalls[0] as { prompt: string };
      assert.doesNotMatch(call.prompt, /Project title rules:/u);
    }
  });

  test("skips the project file when the environment has no workspace", async () => {
    const { fileReads, namer } = createHost({ environmentPath: null });

    const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.equal(result.ok, true);
    assert.deepEqual(fileReads, []);
  });

  test("coalesces duplicate notifications while allowing the next prompt to rename", async () => {
    let releaseFirstInference = () => {};
    const firstInference = new Promise<void>((resolve) => {
      releaseFirstInference = resolve;
    });
    let markFirstInferenceStarted = () => {};
    const firstInferenceStarted = new Promise<void>((resolve) => {
      markFirstInferenceStarted = resolve;
    });
    let inferenceCount = 0;
    const events = [requested()];
    const { namer, updates } = createHost({
      events,
      inferenceComplete: async () => {
        inferenceCount += 1;
        if (inferenceCount === 1) {
          markFirstInferenceStarted();
          await firstInference;
        }
        return `Generated title ${inferenceCount}`;
      },
    });
    const intent = { kind: "automatic" } as const;

    const first = namer.nameThread(THREAD_ID, intent);
    await firstInferenceStarted;
    const second = namer.nameThread(THREAD_ID, intent);
    await Promise.resolve();

    assert.equal(inferenceCount, 1);
    releaseFirstInference();
    await Promise.all([first, second]);
    assert.equal(inferenceCount, 1);
    assert.equal(updates.length, 1);
    events.push(requested(3, "Fix signup", "new-turn"));
    await namer.nameThread(THREAD_ID, intent);
    assert.equal(inferenceCount, 2);
    assert.equal(updates.length, 2);
  });

  test("keeps a manual title written while automatic naming runs", async () => {
    const { namer, updates } = createHost({
      title: "GTD title",
      rereadTitle: "My title",
      events: [requested(), requested(3, "Now investigate billing", "new-turn")],
    });

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
    });

    assert.equal(result.ok, false);
    assert.equal(updates.length, 0);
  });

  test("sends the title prompt through inference without spawning a thread", async () => {
    const { inferenceCalls, namer } = createHost();

    await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.equal(inferenceCalls.length, 1);
    const call = inferenceCalls[0] as { environmentId: string; prompt: string };
    assert.equal(call.environmentId, "env_1");
    assert.match(call.prompt, /Current request:\nFix the login test$/u);
  });

  test("forced naming replaces an archived hand title", async () => {
    const { namer, updates } = createHost({ archivedAt: 1, title: "Hand title" });

    const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.deepEqual(result, { ok: true, title: "Fix the login test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the login test" }]);
  });

  test("strips a premature shipped marker from a submitted request", async () => {
    const { namer } = createHost({
      events: [requested(1, "ship it")],
      inferenceOutput: "☑️ [Login] Test fix",
    });
    assert.deepEqual(await namer.nameThread(THREAD_ID, { kind: "automatic" }), {
      ok: true,
      title: "[Login] Test fix",
    });
  });

  test("reports inference failures without changing the title", async () => {
    const { namer, updates } = createHost({ inferenceError: new Error("inference unavailable") });

    const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.deepEqual(result, { ok: false, error: "inference unavailable" });
    assert.equal(updates.length, 0);
  });
});

type ThreadSubscription = Extract<
  Parameters<BbPluginApi["sdk"]["subscribe"]>[0],
  { event: "thread:changed" }
>;

describe("automatic naming subscription", () => {
  test("reacts only to appended requests and unsubscribes on disposal", async () => {
    const { host, namer, updates } = createHost({ events: [requested()] });
    const unsubscribe = mock(() => {});
    let subscription: ThreadSubscription | undefined;
    host.harness.sdk.stub("subscribe", (args: ThreadSubscription) => {
      subscription = args;
      return unsubscribe;
    });
    const nameThread = mock(namer.nameThread);
    subscribeToThreadNaming(host.bb, { nameThread });
    assert.equal(subscription?.event, "thread:changed");
    assert.equal(host.harness.registrations.threadEventHandlers["thread.idle"], 0);
    const notify = subscription!.callback;
    notify({
      type: "changed",
      entity: "thread",
      id: THREAD_ID,
      changes: ["events-appended"],
      metadata: {
        eventTypes: ["turn/completed"],
      },
    });
    notify({ type: "changed", entity: "thread", id: THREAD_ID, changes: ["title-changed"] });
    notify({
      type: "changed",
      entity: "thread",
      changes: ["events-appended"],
      metadata: {
        eventTypes: ["client/turn/requested"],
      },
    });
    expect(nameThread).not.toHaveBeenCalled();

    notify({
      type: "changed",
      entity: "thread",
      id: THREAD_ID,
      changes: ["events-appended"],
      metadata: {
        eventTypes: ["client/turn/requested"],
      },
    });
    expect(nameThread).toHaveBeenCalledTimes(1);
    await nameThread.mock.results[0]!.value;
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the login test" }]);
    await host.harness.lifecycle.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
