import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { BridgeExecutionOptions, PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { createThreadWriter } from "../src/bridge/timeline.ts";
import { createSessionRegistry, SessionBusyError } from "../src/session.ts";
import { createNanocodexStorage } from "../src/storage.ts";
import { FakeNativeBinding, snapshot } from "./helpers/native.ts";

const OPTIONS = {
  model: "gpt-5.6-sol",
  reasoningLevel: "high",
  serviceTier: "default",
  permissionMode: "full",
} as BridgeExecutionOptions;
const INPUT = [{ type: "text", text: "hello", mentions: [] }] as readonly PromptInput[];

test("resume and exact checkpoint fork use native opaque snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-session-"));
  try {
    const storage = createNanocodexStorage(root);
    const binding = new FakeNativeBinding();
    const registry = createSessionRegistry({ binding, storage });
    const first = snapshot("first");
    binding.plans.push({ snapshot: first });
    const prepared = await registry.prepareNew(sessionOptions("thread", "provider"));
    assert.equal(binding.createCalls[0]?.sessionId, undefined);
    prepared.activate(writer("thread", "provider", []));
    const run = registry.prepareTurn({ threadId: "thread", input: INPUT, clientRequestId: "request-1", options: OPTIONS });
    assert.throws(
      () => registry.prepareTurn({ threadId: "thread", input: INPUT, clientRequestId: "request-busy", options: OPTIONS }),
      SessionBusyError,
    );
    run();
    await eventually(async () => (await storage.readCheckpoint("provider", "0")).lineage_id === first.lineage_id);

    await registry.stop("thread", "release");
    const resumed = await registry.prepareResume(sessionOptions("thread", "provider"));
    resumed.activate(writer("thread", "provider", []));
    assert.equal(binding.createCalls.at(-1)?.durability?.id, "provider");
    assert.equal(binding.createCalls.at(-1)?.resume, undefined);

    const checkpoint = await storage.readCheckpoint("provider", "0");
    const fork = await registry.prepareFork({ ...sessionOptions("fork-thread", "fork-provider"), seed: checkpoint });
    assert.deepEqual(binding.forkSeeds.at(-1), first);
    fork.activate(writer("fork-thread", "fork-provider", []));
    await registry.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fork promotion failure retains the completed native snapshot for crash recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-fork-recovery-"));
  try {
    const storage = createNanocodexStorage(root);
    const binding = new FakeNativeBinding();
    const registry = createSessionRegistry({ binding, storage });
    const seed = snapshot("seed");
    const firstTurn = {
      ...snapshot("first-turn", [{ role: "assistant", content: "branch result" }]),
      prompt_cache_key: seed.prompt_cache_key,
    };
    const prepared = await registry.prepareFork({ ...sessionOptions("thread", "fork"), seed });
    prepared.activate(writer("thread", "fork", []));
    binding.failNextPromotion = true;
    binding.plans.push({ snapshot: firstTurn });
    registry.prepareTurn({ threadId: "thread", input: INPUT, clientRequestId: "fork-1", options: OPTIONS })();
    await eventually(async () => (await storage.readThread("fork")).nextCheckpoint === 1);
    assert.equal(binding.createCalls.at(-1)?.durability?.id, firstTurn.prompt_cache_key);
    const stored = await storage.readThread("fork");
    assert.deepEqual(stored.forkSeed, firstTurn);
    assert.deepEqual(stored.checkpoints["0"]?.history, firstTurn.history);

    await registry.stop("thread", "release");
    const recovered = await registry.prepareResume(sessionOptions("thread", "fork"));
    assert.deepEqual(binding.forkSeeds.at(-1), firstTurn);
    recovered.activate(writer("thread", "fork", []));
    await registry.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native compact checkpoints exact compacted history and projects one compaction delta", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-compact-"));
  try {
    const storage = createNanocodexStorage(root);
    const binding = new FakeNativeBinding();
    const registry = createSessionRegistry({ binding, storage });
    const messages: unknown[] = [];
    binding.plans.push({ snapshot: snapshot("before") });
    const prepared = await registry.prepareNew(sessionOptions("thread", "provider"));
    prepared.activate(writer("thread", "provider", messages));
    registry.prepareTurn({ threadId: "thread", input: INPUT, clientRequestId: "normal", options: OPTIONS })();
    await eventually(async () => (await storage.readThread("provider")).nextCheckpoint === 1);

    const compactedHistory = [{ role: "system", content: "native compact summary" }];
    binding.compactContext = { workspace: "/workspace-after-compact", history: compactedHistory };
    registry.prepareTurn({
      threadId: "thread",
      input: compactInput(),
      clientRequestId: "compact",
      options: OPTIONS,
    })();
    await eventually(async () => (await storage.readThread("provider")).nextCheckpoint === 2);
    const compactCheckpoint = await storage.readCheckpoint("provider", "1");
    assert.deepEqual(compactCheckpoint.history, compactedHistory);
    assert.equal(compactCheckpoint.workspace, "/workspace-after-compact");
    assert.equal(deltas(messages).filter((delta) => delta.kind === "context.compacted").length, 1);

    const fork = await registry.prepareFork({
      ...sessionOptions("fork-thread", "fork-provider"),
      seed: compactCheckpoint,
    });
    assert.deepEqual(binding.forkSeeds.at(-1)?.history, compactedHistory);
    await fork.dispose();
    await registry.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("steer failure settles its request, warns, and interrupt preserves the native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-steer-"));
  try {
    const storage = createNanocodexStorage(root);
    const binding = new FakeNativeBinding();
    const registry = createSessionRegistry({ binding, storage });
    const messages: unknown[] = [];
    const prepared = await registry.prepareNew(sessionOptions("thread", "provider"));
    prepared.activate(writer("thread", "provider", messages));
    binding.plans.push({ snapshot: snapshot("held"), hold: true, steerError: new Error("steer lost") });
    registry.prepareTurn({ threadId: "thread", input: INPUT, clientRequestId: "turn", options: OPTIONS })();
    await eventually(() => deltas(messages).some((delta) => delta.kind === "turn.open"));
    await registry.prepareSteer({ threadId: "thread", input: INPUT, clientRequestId: "steer", options: OPTIONS })();
    await registry.stop("thread", "interrupt");

    const projected = deltas(messages);
    assert.ok(projected.some((delta) => delta.kind === "provider.warning" && delta.details === "steer lost"));
    assert.ok(projected.some((delta) => delta.kind === "input.accepted" && delta.clientRequestId === "steer"));
    assert.ok(projected.some((delta) => delta.kind === "turn.boundary" && delta.status === "interrupted"));
    const agentsBeforeNextTurn = binding.createCalls.length;
    binding.plans.push({ snapshot: snapshot("after-interrupt") });
    registry.prepareTurn({ threadId: "thread", input: INPUT, clientRequestId: "after", options: OPTIONS })();
    await eventually(async () => (await storage.readThread("provider")).nextCheckpoint === 1);
    assert.equal(binding.createCalls.length, agentsBeforeNextTurn);
    await registry.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sessionOptions(threadId: string, providerThreadId: string) {
  return { threadId, providerThreadId, cwd: "/workspace", options: OPTIONS };
}

function writer(threadId: string, providerThreadId: string, messages: unknown[]) {
  return createThreadWriter({ threadId, providerThreadId, send: (message) => messages.push(message) });
}

function compactInput(): readonly PromptInput[] {
  return [{
    type: "text",
    text: "/compact",
    mentions: [{
      start: 0,
      end: 8,
      resource: {
        kind: "command",
        source: "command",
        origin: "builtin",
        trigger: "/",
        name: "compact",
        label: "Compact",
        argumentHint: null,
      },
    }],
  }] as readonly PromptInput[];
}

function deltas(messages: readonly unknown[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { method?: unknown; params?: { deltas?: unknown } };
    return record.method === "thread/delta" && Array.isArray(record.params?.deltas)
      ? record.params.deltas as Record<string, unknown>[]
      : [];
  });
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (await predicate()) return;
    } catch {
      // The expected file may not exist until the async turn reaches its checkpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
}
