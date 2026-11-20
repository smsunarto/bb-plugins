import assert from "node:assert/strict";
import { describe, onTestFinished, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createThreadNamer } from "../thread-namer.ts";

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
    events?: readonly unknown[];
    rereadTitle?: string | null;
    title?: string | null;
    archivedAt?: number | null;
    environmentPath?: string | null;
    environmentId?: () => string | null;
    environmentStatus?: () => "ready" | "provisioning";
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
            status: options.environmentStatus?.() ?? "ready",
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
          if (options.environmentId) thread.environmentId = options.environmentId();
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
  // Disposing removes the fake host's storage dir.
  onTestFinished(() => host.harness.lifecycle.dispose());
  const namer = createThreadNamer(host.bb, {
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

describe("thread naming progress", () => {
  for (const outcome of ["rename", "failure"] as const) {
    test(`reports naming only while inference is running and clears after ${outcome}`, async () => {
      let start!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      let finish!: (value: string) => void;
      let fail!: (error: Error) => void;
      const result = new Promise<string>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const { namer, host } = createHost({
        events: [requested()],
        inferenceComplete: () => {
          start();
          return result;
        },
      });
      assert.deepEqual(namer.listNamingThreads(), []);
      const operation = namer.regenerateTitle(THREAD_ID);
      await started;
      assert.deepEqual(namer.listNamingThreads(), [THREAD_ID]);
      if (outcome === "failure") fail(new Error("Inference failed"));
      else finish("New title");
      const finished = await operation;
      assert.equal(finished.ok, outcome !== "failure");
      assert.deepEqual(namer.listNamingThreads(), []);
      // Once when naming starts, once when it ends.
      assert.deepEqual(host.harness.inspection.experimental_rpcInvalidations, [
        ["naming"],
        ["naming"],
      ]);
      await host.harness.lifecycle.dispose();
    });
  }
});

describe("composer context naming", () => {
  for (const kind of ["regenerate"] as const) {
    test(`${kind} receives resolved composer chip context`, async () => {
      const event = requested(1, "Fix it @Browser");
      const { namer, inferenceCalls, updates } = createHost({
        events: [
          {
            ...event,
            data: {
              ...event.data,
              input: [
                ...event.data.input,
                {
                  type: "text",
                  text: 'Context for @Browser (resolved by plugin "browser"):\n\nThe checkout page shows a broken payment button.',
                  mentions: [],
                  visibility: "agent-only",
                },
              ],
            },
          },
        ],
        inferenceOutput: "Fix checkout payment button",
      });

      assert.deepEqual(await namer.regenerateTitle(THREAD_ID), {
        ok: true,
        title: "Fix checkout payment button",
      });
      assert.match(
        (inferenceCalls[0] as { prompt: string }).prompt,
        /The checkout page shows a broken payment button\./u,
      );
      assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix checkout payment button" }]);
    });
  }
});

describe("createThreadNamer", () => {
  test("names an untitled thread when its first prompt arrives", async () => {
    const { namer, updates } = createHost({ events: [requested()] });

    const result = await namer.regenerateTitle(THREAD_ID);

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

      const result = await namer.regenerateTitle(THREAD_ID);

      assert.equal(result.ok, true);
      assert.equal(inferenceCalls.length, 1);
      assert.equal(updates.length, 1);
    }
  });

  test("regenerates a titled thread from its latest prompt on request", async () => {
    const { inferenceCalls, namer, updates } = createHost({
      events: [requested(), completed(), requested(3, "Now fix signup", "new-turn"), completed(4)],
      inferenceOutput: "Fix the signup test",
      title: "Fix the login test",
    });

    const result = await namer.regenerateTitle(THREAD_ID);

    assert.deepEqual(result, { ok: true, title: "Fix the signup test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the signup test" }]);
    assert.match(
      (inferenceCalls[0] as { prompt: string }).prompt,
      /<current_request>\nNow fix signup/u,
    );
  });

  test("replaces BB's existing title", async () => {
    const { namer, updates, inferenceCalls } = createHost({
      title: "BB internal title",
      inferenceOutput: "GTD task title",
      events: [requested()],
    });
    assert.deepEqual(await namer.regenerateTitle(THREAD_ID), {
      ok: true,
      title: "GTD task title",
    });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "GTD task title" }]);
    assert.equal(inferenceCalls.length, 1);
  });

  test("does not write an identical generated title", async () => {
    const { namer, updates } = createHost({ title: "Fix the login test" });
    assert.equal((await namer.regenerateTitle(THREAD_ID)).ok, true);
    assert.deepEqual(updates, []);
  });

  test("reads project title instructions from the active workspace", async () => {
    const { fileReads, inferenceCalls, namer } = createHost({
      projectInstructions: "Prefix every title with API:",
    });

    const result = await namer.regenerateTitle(THREAD_ID);

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

      const result = await namer.regenerateTitle(THREAD_ID);

      assert.equal(result.ok, true);
      const call = inferenceCalls[0] as { prompt: string };
      assert.doesNotMatch(call.prompt, /Project title rules:/u);
    }
  });

  test("skips the project file when the environment has no workspace", async () => {
    const { fileReads, namer } = createHost({ environmentPath: null });

    const result = await namer.regenerateTitle(THREAD_ID);

    assert.equal(result.ok, true);
    assert.deepEqual(fileReads, []);
  });

  test("sends the title prompt through inference without spawning a thread", async () => {
    const { inferenceCalls, namer } = createHost();

    await namer.regenerateTitle(THREAD_ID);

    assert.equal(inferenceCalls.length, 1);
    const call = inferenceCalls[0] as { environmentId: string; prompt: string };
    assert.equal(call.environmentId, "env_1");
    assert.match(call.prompt, /<current_request>\nFix the login test\n<\/current_request>/u);
  });

  test("forced naming replaces an archived hand title", async () => {
    const { namer, updates } = createHost({ archivedAt: 1, title: "Hand title" });

    const result = await namer.regenerateTitle(THREAD_ID);

    assert.deepEqual(result, { ok: true, title: "Fix the login test" });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Fix the login test" }]);
  });

  test("strips a premature shipped marker from a submitted request", async () => {
    const { namer } = createHost({
      events: [requested(1, "ship it")],
      inferenceOutput: "☑️ [Login] Test fix",
    });
    assert.deepEqual(await namer.regenerateTitle(THREAD_ID), {
      ok: true,
      title: "[Login] Test fix",
    });
  });

  test("rejects a second regeneration while one is running", async () => {
    let release = (_title: string) => {};
    let started = () => {};
    const inferenceStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { namer, updates } = createHost({
      events: [requested()],
      inferenceComplete: () =>
        new Promise<string>((resolve) => {
          release = resolve;
          started();
        }),
    });
    const first = namer.regenerateTitle(THREAD_ID);
    await inferenceStarted;
    assert.deepEqual(await namer.regenerateTitle(THREAD_ID), {
      ok: false,
      error: "This thread is already being named.",
    });
    release("Fix the login test");
    assert.deepEqual(await first, { ok: true, title: "Fix the login test" });
    assert.equal(updates.length, 1);
  });

  test("sets an agent's title without inference and reports the previous one", async () => {
    const { inferenceCalls, namer, updates } = createHost({ title: "Old title" });
    assert.deepEqual(await namer.renameThread(THREAD_ID, "  📝 Add CSV  export "), {
      ok: true,
      previousTitle: "Old title",
      title: "Add CSV export",
      projectId: "proj_1",
      environmentId: "env_1",
    });
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "Add CSV export" }]);
    assert.deepEqual(inferenceCalls, []);
  });

  test("reports inference failures without changing the title", async () => {
    const { namer, updates } = createHost({ inferenceError: new Error("inference unavailable") });

    const result = await namer.regenerateTitle(THREAD_ID);

    assert.deepEqual(result, { ok: false, error: "inference unavailable" });
    assert.equal(updates.length, 0);
  });
});
