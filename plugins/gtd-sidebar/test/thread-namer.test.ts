import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createThreadNamer } from "../thread-namer.ts";

const THREAD_ID = "thr_target";

function requested(
  seq = 1,
  text = "Fix the login test",
  target: "thread-start" | "new-turn" = "thread-start",
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
    inferenceComplete?: (input: unknown) => Promise<string>;
    inferenceError?: Error;
    inferenceOutput?: string;
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
        return options.inferenceOutput ?? "Fix the login test";
      },
    },
  });

  return { fileReads, host, inferenceCalls, namer, updates };
}

describe("createThreadNamer", () => {
  test("names an untitled thread after its first completed turn", async () => {
    const { namer, updates } = createHost();

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
      lastAssistantText: "Login tests pass.",
    });

    assert.deepEqual(result, { ok: true, title: "Fix the login test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the login test" }]);
  });

  test("waits until the latest user turn completes", async () => {
    for (const events of [
      [requested()],
      [requested(), completed(), requested(3, "Now fix signup", "new-turn")],
    ]) {
      const { inferenceCalls, namer, updates } = createHost({ events });

      const result = await namer.nameThread(THREAD_ID, {
        kind: "automatic",
        lastAssistantText: "Login tests pass.",
      });

      assert.equal(result.ok, false);
      assert.equal(inferenceCalls.length, 0);
      assert.equal(updates.length, 0);
    }
  });

  test("does not read project instructions when naming will be skipped", async () => {
    const { fileReads, namer } = createHost({ automatic: false });

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
      lastAssistantText: null,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(fileReads, []);
  });

  test("regenerates an existing title from the latest prompt and agent handoff", async () => {
    const { inferenceCalls, namer, updates } = createHost({
      events: [requested(), completed(), requested(3, "Now fix signup", "new-turn"), completed(4)],
      inferenceOutput: "Fix the signup test",
      title: "Fix the login test",
    });

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
      lastAssistantText: "Login is fixed and all tests pass.",
    });

    assert.deepEqual(result, { ok: true, title: "Fix the signup test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the signup test" }]);
    const call = inferenceCalls[0] as { prompt: string };
    assert.match(call.prompt, /User prompt:\nNow fix signup/u);
    assert.match(
      call.prompt,
      /Agent's last turn handoff message:\nLogin is fixed and all tests pass\.$/u,
    );
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
        path: "/workspace/.agents/GTD_TITLE.md",
        rootPath: "/workspace",
      },
    ]);
    const call = inferenceCalls[0] as { prompt: string };
    assert.match(
      call.prompt,
      /Project-specific title instructions:\nPrefix every title with API:\n\nUser prompt:/u,
    );
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
      assert.doesNotMatch(call.prompt, /Project-specific title instructions:/u);
    }
  });

  test("skips the project file when the environment has no workspace", async () => {
    const { fileReads, namer } = createHost({ environmentPath: null });

    const result = await namer.nameThread(THREAD_ID, { kind: "forced" });

    assert.equal(result.ok, true);
    assert.deepEqual(fileReads, []);
  });

  test("queues another automatic name while inference is still running", async () => {
    let releaseFirstInference = () => {};
    const firstInference = new Promise<void>((resolve) => {
      releaseFirstInference = resolve;
    });
    let markFirstInferenceStarted = () => {};
    const firstInferenceStarted = new Promise<void>((resolve) => {
      markFirstInferenceStarted = resolve;
    });
    let inferenceCount = 0;
    const { namer, updates } = createHost({
      inferenceComplete: async () => {
        inferenceCount += 1;
        if (inferenceCount === 1) {
          markFirstInferenceStarted();
          await firstInference;
        }
        return `Generated title ${inferenceCount}`;
      },
    });
    const intent = { kind: "automatic", lastAssistantText: null } as const;

    const first = namer.nameThread(THREAD_ID, intent);
    await firstInferenceStarted;
    const second = namer.nameThread(THREAD_ID, intent);
    await Promise.resolve();

    assert.equal(inferenceCount, 1);
    releaseFirstInference();
    await Promise.all([first, second]);
    assert.equal(inferenceCount, 2);
    assert.equal(updates.length, 2);
  });

  test("keeps a manual title written while automatic naming runs", async () => {
    const { namer, updates } = createHost({ rereadTitle: "My title" });

    const result = await namer.nameThread(THREAD_ID, {
      kind: "automatic",
      lastAssistantText: "Login tests pass.",
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
