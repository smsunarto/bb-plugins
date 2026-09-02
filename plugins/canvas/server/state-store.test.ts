import { test } from "bun:test";
import assert from "node:assert/strict";
import { stateKeyOf, type CanvasSource } from "../shared/document.ts";
import { fakeBb } from "./fake-bb.ts";
import { clearState, kvKeyOf, readState, writeState } from "./state-store.ts";

const source: CanvasSource = { kind: "host", hostId: null, path: "/tmp/a.canvas.mdx" };

test("readState returns the empty state when nothing is stored or the row is malformed", async () => {
  const bb = fakeBb({});
  assert.deepEqual(await readState(bb, source), { values: {}, revision: 0 });
  await bb.storage.kv.set(kvKeyOf(source), { junk: true });
  assert.deepEqual(await readState(bb, source), { values: {}, revision: 0 });
});

test("writeState bumps the revision only when the value changes and publishes each change", async () => {
  const bb = fakeBb({});
  const first = await writeState(bb, source, "toggle", true);
  assert.deepEqual(first, { values: { toggle: true }, revision: 1 });
  const same = await writeState(bb, source, "toggle", true);
  assert.equal(same.revision, 1);
  const second = await writeState(bb, source, "pick", ["a", 1]);
  assert.deepEqual(second, { values: { toggle: true, pick: ["a", 1] }, revision: 2 });
  assert.deepEqual(bb.calls.published, [
    { channel: "canvas:state", payload: { stateKey: stateKeyOf(source), revision: 1 } },
    { channel: "canvas:state", payload: { stateKey: stateKeyOf(source), revision: 2 } },
  ]);
  assert.deepEqual(await readState(bb, source), second);
});

test("clearState deletes the row and publishes a new revision", async () => {
  const bb = fakeBb({});
  await writeState(bb, source, "toggle", true);
  const cleared = await clearState(bb, source);
  assert.deepEqual(cleared, { values: {}, revision: 2 });
  assert.equal(await bb.storage.kv.get(kvKeyOf(source)), undefined);
  assert.equal(bb.calls.published.length, 2);
});
