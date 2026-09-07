import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeContext, type FakeContext } from "../fake-context.ts";
import { monacoAssets } from "./monaco-assets.ts";

type CreatePreview = FakeContext["bb"]["sdk"]["files"]["createPreview"];

async function makeBundle(
  files = ["editor.js", "editor.css", "editor.worker.js"],
): Promise<string> {
  const bundleDir = await mkdtemp(path.join(os.tmpdir(), "dotfiles-monaco-assets-"));
  await Promise.all(files.map((name) => writeFile(path.join(bundleDir, name), name)));
  return bundleDir;
}

function contextWithPreview(createPreview: CreatePreview): FakeContext {
  const ctx = createFakeContext();
  (ctx.bb as unknown as { sdk: { files: { createPreview: CreatePreview } } }).sdk = {
    files: { createPreview },
  };
  return ctx;
}

test("rejects a bundle unless all three Monaco assets are files", async () => {
  const bundleDir = await makeBundle(["editor.js", "editor.css"]);
  const createPreview = mock<CreatePreview>();
  const query = monacoAssets.create({ bundleDir });

  try {
    await assert.rejects(
      async () => query.execute(contextWithPreview(createPreview)),
      /Monaco asset missing: dist\/monaco\/editor\.worker\.js/,
    );
    assert.equal(createPreview.mock.calls.length, 0);
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
});

test("reuses a healthy lease and refreshes it inside five minutes", async () => {
  const bundleDir = await makeBundle();
  let now = 1_000;
  let previewCount = 0;
  const createPreview = mock<CreatePreview>(async () => {
    previewCount += 1;
    return {
      baseUrl: `https://assets.example/${previewCount}`,
      expiresAtMs: previewCount === 1 ? 3_601_000 : 7_201_000,
    };
  });
  const query = monacoAssets.create({ bundleDir, now: () => now });
  const ctx = contextWithPreview(createPreview);

  try {
    const first = await query.execute(ctx);
    const reused = await query.execute(ctx);
    now = 3_301_001;
    const refreshed = await query.execute(ctx);

    assert.strictEqual(reused, first);
    assert.equal(refreshed.baseUrl, "https://assets.example/2");
    assert.deepEqual(createPreview.mock.calls, [
      [{ rootPath: bundleDir, ttlMs: 3_600_000 }],
      [{ rootPath: bundleDir, ttlMs: 3_600_000 }],
    ]);
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
});

test("coalesces concurrent preview creation", async () => {
  const bundleDir = await makeBundle();
  let resolvePreview!: (lease: Awaited<ReturnType<CreatePreview>>) => void;
  const createPreview = mock<CreatePreview>(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
  );
  const query = monacoAssets.create({ bundleDir });
  const ctx = contextWithPreview(createPreview);

  try {
    const first = query.execute(ctx);
    const second = query.execute(ctx);
    while (createPreview.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(createPreview.mock.calls.length, 1);
    resolvePreview({
      baseUrl: "https://assets.example/shared",
      expiresAtMs: Date.now() + 3_600_000,
    });
    assert.strictEqual(await first, await second);
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
});

test("clears a failed refresh so the next request can retry", async () => {
  const bundleDir = await makeBundle();
  let attempt = 0;
  const createPreview = mock<CreatePreview>(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("preview unavailable");
    return { baseUrl: "https://assets.example/retry", expiresAtMs: Date.now() + 3_600_000 };
  });
  const query = monacoAssets.create({ bundleDir });
  const ctx = contextWithPreview(createPreview);

  try {
    await assert.rejects(async () => query.execute(ctx), /preview unavailable/);
    assert.equal((await query.execute(ctx)).baseUrl, "https://assets.example/retry");
    assert.equal(createPreview.mock.calls.length, 2);
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
});
