import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
// bb-kit currently resolves an older SDK with a different event union. This plugin
// uses only storage, RPC, CLI and realtime APIs shared by both SDK versions.
const factory = (bb: ReturnType<typeof createFakePluginHost>["bb"]) =>
  plugin(bb as unknown as Parameters<typeof plugin>[0]);
async function load() {
  const host = createFakePluginHost({ pluginId: "remind-me" });
  hosts.push(host);
  await factory(host.bb);
  return host;
}
const input = {
  id: "71e25fe5-c24c-40d5-92b1-6f7c5fe28e90",
  title: "Review keyboard navigation",
  body: "Context: the new list needs a keyboard pass.\n\nNext step: test Tab and Enter.",
  sourceThreadId: "thr_source",
};

test("saves separately, reads back through RPC, and survives a plugin reload", async () => {
  const host = await load();
  const saved = await host.harness.callRpc("save", input);
  const stored = (saved as { reminder: typeof input & { createdAt: string } }).reminder;
  assert.deepEqual(stored, { ...input, createdAt: stored.createdAt });
  assert.ok(Number.isFinite(Date.parse(stored.createdAt)));
  assert.deepEqual(await host.harness.callRpc("get", { id: input.id }), saved);
  const reloaded = await host.harness.lifecycle.reload(factory);
  hosts.push(reloaded);
  assert.deepEqual(await reloaded.harness.callRpc("list"), {
    reminders: [(saved as { reminder: unknown }).reminder],
  });
  assert.deepEqual(host.harness.inspection.sdk.calls, []);
  assert.deepEqual(reloaded.harness.inspection.sdk.calls, []);
});

test("concurrent retry of a save creates one reminder and does not overwrite different content", async () => {
  const { harness } = await load();
  const [first, retry] = await Promise.all([
    harness.callRpc("save", input),
    harness.callRpc("save", input),
  ]);
  assert.deepEqual(retry, first);
  await assert.rejects(
    harness.callRpc("save", { ...input, body: "Different work" }),
    /already used/,
  );
  assert.deepEqual(await harness.callRpc("list"), {
    reminders: [(first as { reminder: unknown }).reminder],
  });
});

test("rejects blank or oversized reminders before persisting", async () => {
  const { harness } = await load();
  for (const invalid of [
    { ...input, title: "   " },
    { ...input, body: "a".repeat(20001) },
    { ...input, id: "bad" },
  ]) {
    await assert.rejects(harness.callRpc("save", invalid));
  }
  assert.deepEqual(await harness.callRpc("list"), { reminders: [] });
});
