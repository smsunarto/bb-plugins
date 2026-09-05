import { afterEach, expect, test } from "bun:test";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";

import { EmbedCache, embedCacheKey } from "../src/app/embed-cache.ts";
import plugin from "../src/server/server.ts";
import { renderEmbedOutputSchema } from "../src/shared/contract.ts";

const path = "src/example.ts";
const patch = `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
@@ -10 +10 @@
-later
+LATER
`;
const request = { kind: "diff", threadId: "thread-1", messageId: "message-1", path } as const;
const hosts: FakePluginHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function snapshotHost(initialPatch: string | undefined = patch) {
  const host = createFakePluginHost({ pluginId: "kitchen-sink" });
  hosts.push(host);
  const state: { patch: string | undefined; inaccessible: boolean } = {
    patch: initialPatch,
    inaccessible: false,
  };
  host.harness.sdk.stub("threads.get", () => {
    if (state.inaccessible) throw new Error("Workspace removed");
    return makeThreadResponse({ id: request.threadId, environmentId: "environment-1" });
  });
  host.harness.sdk.stub("environments.get", () => ({
    id: "environment-1",
    mergeBaseBranch: "main",
  }));
  host.harness.sdk.stub("environments.diffPatch", () => ({
    outcome: "available",
    patches: state.patch === undefined ? [] : [{ path, patch: state.patch, truncated: false }],
  }));
  await plugin(host.bb);
  return { ...host, state };
}

test("a displayed diff survives shipping and browser cache invalidation", async () => {
  const host = await snapshotHost();
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 10_000 });
  const key = embedCacheKey(request);
  const fetch = async () =>
    renderEmbedOutputSchema.parse(await host.harness.behavior.callRpc("renderEmbed", request));
  const onThrow = () => ({ status: "error" as const, message: "failed" });
  await cache.load(key, request.threadId, fetch, onThrow);
  const before = cache.read(key).value;
  expect(before).toMatchObject({ status: "ready", patch });

  host.state.patch = undefined;
  cache.invalidateThread(request.threadId);
  await cache.load(key, request.threadId, fetch, onThrow);
  expect(cache.read(key)).toEqual({ value: before, stale: false });
  expect(host.harness.sdk.callsTo("environments.diffPatch")).toHaveLength(1);
});

test("a fresh plugin load reads the saved diff before accessing its removed workspace", async () => {
  const host = await snapshotHost();
  const before = await host.harness.behavior.callRpc("renderEmbed", request);
  expect(before).toMatchObject({ status: "ready", patch });
  const oldDatabase = host.bb.storage.database();
  const reloaded = await host.harness.lifecycle.reload(plugin);
  hosts.push(reloaded);
  expect(oldDatabase.open).toBe(false);
  expect(reloaded.bb.storage.database()).not.toBe(oldDatabase);
  expect(await reloaded.harness.behavior.callRpc("renderEmbed", request)).toEqual(before);
  expect(reloaded.harness.sdk.callsTo("threads.get")).toHaveLength(0);
  expect(reloaded.harness.sdk.callsTo("environments.get")).toHaveLength(0);
});

test("different messages, threads, and ranges save independent diffs", async () => {
  const host = await snapshotHost();
  const variants = [
    request,
    { ...request, messageId: "message-2" },
    { ...request, threadId: "thread-2" },
    { ...request, start: 1, end: 1 },
    { ...request, start: 10, end: 10 },
  ];
  const snapshots = [];
  for (const [index, input] of variants.entries()) {
    host.state.patch = patch.replaceAll("new", `new-${index}`);
    const result = await host.harness.behavior.callRpc("renderEmbed", input);
    expect(result).toMatchObject({ status: "ready", path: input.path });
    snapshots.push(result);
  }
  host.state.inaccessible = true;
  for (const [index, input] of variants.entries()) {
    expect(await host.harness.behavior.callRpc("renderEmbed", input)).toEqual(snapshots[index]);
  }
  expect(snapshots[3]).toMatchObject({ label: `${path}:L1` });
  expect(snapshots[4]).toMatchObject({ label: `${path}:L10` });
  expect(snapshots[3]).not.toEqual(snapshots[4]);
});

test("a mismatched file response cannot become a saved diff for the requested path", async () => {
  const host = await snapshotHost();
  const input = { ...request, path: "src/other.ts" };
  expect(await host.harness.behavior.callRpc("renderEmbed", input)).toMatchObject({
    status: "empty",
  });
  host.harness.sdk.stub("environments.diffPatch", () => ({
    outcome: "available",
    patches: [{ path: input.path, patch: patch.replaceAll(path, input.path), truncated: false }],
  }));
  expect(await host.harness.behavior.callRpc("renderEmbed", input)).toMatchObject({
    status: "ready",
    path: input.path,
    patch: patch.replaceAll(path, input.path),
  });
});

test("failed snapshot writes do not report a ready diff and can retry", async () => {
  const host = await snapshotHost();
  const db = host.bb.storage.database();
  db.exec(
    "CREATE TRIGGER fail_snapshot BEFORE INSERT ON diff_snapshots BEGIN SELECT RAISE(FAIL, 'write failed'); END",
  );
  expect(await host.harness.behavior.callRpc("renderEmbed", request)).toEqual({
    status: "error",
    message: `Could not save the diff for ${path}.`,
  });
  db.exec("DROP TRIGGER fail_snapshot");
  expect(await host.harness.behavior.callRpc("renderEmbed", request)).toMatchObject({
    status: "ready",
    patch,
  });
});

test("empty and failed requests retry until a ready diff is available", async () => {
  const host = await snapshotHost();
  host.state.patch = undefined;
  expect(await host.harness.behavior.callRpc("renderEmbed", request)).toMatchObject({
    status: "empty",
  });
  host.state.inaccessible = true;
  expect(await host.harness.behavior.callRpc("renderEmbed", request)).toMatchObject({
    status: "error",
  });
  host.state.inaccessible = false;
  host.state.patch = patch;
  expect(await host.harness.behavior.callRpc("renderEmbed", request)).toMatchObject({
    status: "ready",
    patch,
  });
});

test("concurrent first displays return the first saved snapshot", async () => {
  const host = await snapshotHost();
  let finishFirst!: (value: unknown) => void;
  let finishSecond!: (value: unknown) => void;
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => (bothStarted = resolve));
  const pending = [
    new Promise((resolve) => (finishFirst = resolve)),
    new Promise((resolve) => (finishSecond = resolve)),
  ];
  host.harness.sdk.stub("environments.diffPatch", () => {
    const result = pending.shift();
    if (pending.length === 0) bothStarted();
    return result;
  });
  const first = host.harness.behavior.callRpc("renderEmbed", request);
  const second = host.harness.behavior.callRpc("renderEmbed", request);
  await started;
  const winner = patch.replaceAll("new", "winner");
  finishSecond({ outcome: "available", patches: [{ path, patch: winner, truncated: false }] });
  const saved = await second;
  finishFirst({ outcome: "available", patches: [{ path, patch, truncated: false }] });
  expect(await first).toEqual(saved);
  expect(saved).toMatchObject({ status: "ready", patch: winner });
});

test("requests without message ids keep reading the current workspace", async () => {
  const host = await snapshotHost();
  const input = { kind: "diff", threadId: request.threadId, path };
  expect(await host.harness.behavior.callRpc("renderEmbed", input)).toMatchObject({
    status: "ready",
  });
  host.state.patch = undefined;
  expect(await host.harness.behavior.callRpc("renderEmbed", input)).toMatchObject({
    status: "empty",
  });
});

test("archive retains snapshots and thread deletion removes only that thread", async () => {
  const host = await snapshotHost();
  const other = { ...request, threadId: "thread-2" };
  const saved = await host.harness.behavior.callRpc("renderEmbed", request);
  await host.harness.behavior.callRpc("renderEmbed", other);
  host.state.patch = undefined;
  const thread = makeThreadResponse({ id: request.threadId });
  await host.harness.behavior.emitThreadEvent("thread.archived", { thread });
  expect(await host.harness.behavior.callRpc("renderEmbed", request)).toEqual(saved);
  await host.harness.behavior.emitThreadEvent("thread.deleted", { thread });
  expect(await host.harness.behavior.callRpc("renderEmbed", request)).toMatchObject({
    status: "empty",
  });
  expect(await host.harness.behavior.callRpc("renderEmbed", other)).toEqual(saved);
});
