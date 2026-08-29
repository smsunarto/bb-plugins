import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type * as MonacoNs from "monaco-editor";
import { createMonacoRuntime, type MonacoRuntimeDependencies } from "./runtime.ts";

function fakeNamespace(): typeof MonacoNs {
  return {
    languages: {
      getLanguages: () => [],
      registerDocumentHighlightProvider: mock(() => ({ dispose() {} })),
      DocumentHighlightKind: { Text: 0 },
    },
  } as unknown as typeof MonacoNs;
}

function runtimeHarness(overrides: Partial<MonacoRuntimeDependencies> = {}) {
  const timers: Array<{ callback: () => Promise<void>; delayMs: number; cancelled: boolean }> = [];
  const injectStylesheet = mock<(url: string) => Promise<void>>(async () => {});
  const createWorker = mock<(url: string) => Worker>(() => ({}) as Worker);
  const schedule = mock<MonacoRuntimeDependencies["schedule"]>((callback, delayMs) => {
    const timer = { callback, delayMs, cancelled: false };
    timers.push(timer);
    return timer;
  });
  const cancel = mock<MonacoRuntimeDependencies["cancel"]>((handle) => {
    (handle as (typeof timers)[number]).cancelled = true;
  });
  const dependencies: MonacoRuntimeDependencies = {
    now: () => 0,
    loadModule: async () => ({ monaco: fakeNamespace() }),
    injectStylesheet,
    createWorker,
    schedule,
    cancel,
    ...overrides,
  };
  return {
    runtime: createMonacoRuntime(dependencies),
    timers,
    injectStylesheet,
    createWorker,
    schedule,
    cancel,
  };
}

test("coalesces the asset lease and Monaco boot for concurrent acquisitions", async () => {
  let resolveAssets!: (lease: { baseUrl: string; expiresAtMs: number }) => void;
  const loadAssets = mock(
    () =>
      new Promise<{ baseUrl: string; expiresAtMs: number }>((resolve) => {
        resolveAssets = resolve;
      }),
  );
  const loadModule = mock<MonacoRuntimeDependencies["loadModule"]>(async () => ({
    monaco: fakeNamespace(),
  }));
  const harness = runtimeHarness({ loadModule });

  const first = harness.runtime.acquire(loadAssets);
  const second = harness.runtime.acquire(loadAssets);
  assert.equal(loadAssets.mock.calls.length, 1);
  resolveAssets({ baseUrl: "https://assets.example/one", expiresAtMs: 3_600_000 });
  const [firstAcquisition, secondAcquisition] = await Promise.all([first, second]);

  assert.equal(loadModule.mock.calls.length, 1);
  assert.equal(harness.injectStylesheet.mock.calls.length, 1);
  firstAcquisition.release();
  secondAcquisition.release();
});

test("clears a failed boot so Retry can load Monaco again", async () => {
  let bootAttempt = 0;
  const loadModule = mock<MonacoRuntimeDependencies["loadModule"]>(async () => {
    bootAttempt += 1;
    if (bootAttempt === 1) throw new Error("module unavailable");
    return { monaco: fakeNamespace() };
  });
  const loadAssets = mock(async () => ({
    baseUrl: "https://assets.example/retry",
    expiresAtMs: 3_600_000,
  }));
  const harness = runtimeHarness({ loadModule });

  await assert.rejects(() => harness.runtime.acquire(loadAssets), /module unavailable/);
  const acquisition = await harness.runtime.acquire(loadAssets);

  assert.equal(loadAssets.mock.calls.length, 1);
  assert.equal(loadModule.mock.calls.length, 2);
  assert.equal(harness.injectStylesheet.mock.calls.length, 1);
  acquisition.release();
});

test("renews the worker lease while acquired and uses the new base URL", async () => {
  let now = 0;
  let leaseCount = 0;
  const loadAssets = mock(async () => {
    leaseCount += 1;
    return {
      baseUrl: `https://assets.example/${leaseCount}`,
      expiresAtMs: leaseCount * 3_600_000,
    };
  });
  const harness = runtimeHarness({ now: () => now });
  const previousEnvironment = globalThis.MonacoEnvironment;

  try {
    const acquisition = await harness.runtime.acquire(loadAssets);
    const firstTimer = harness.timers.at(-1);
    assert.ok(firstTimer);
    assert.equal(firstTimer.delayMs, 3_300_000);
    globalThis.MonacoEnvironment?.getWorker?.("editor", "editor");

    now = 3_300_000;
    await firstTimer.callback();
    globalThis.MonacoEnvironment?.getWorker?.("editor", "editor");

    assert.deepEqual(harness.createWorker.mock.calls, [
      ["https://assets.example/1/editor.worker.js"],
      ["https://assets.example/2/editor.worker.js"],
    ]);
    assert.equal(loadAssets.mock.calls.length, 2);
    acquisition.release();
    acquisition.release();
    assert.equal(harness.timers.at(-1)?.cancelled, true);
  } finally {
    globalThis.MonacoEnvironment = previousEnvironment;
  }
});
