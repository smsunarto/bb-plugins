import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb } from "../fake-bb.ts";
import { kvKeyOf } from "../state-store.ts";
import { state } from "./state.ts";

const source: CanvasSource = { kind: "thread-storage", threadId: "t1", path: "c.canvas.mdx" };

test("state returns the stored values and revision without touching the host", async () => {
  const bb = fakeBb({});
  assert.deepEqual(await state.execute({ bb }, { source }), { values: {}, revision: 0 });
  await bb.storage.kv.set(kvKeyOf(source), { values: { a: 1 }, revision: 3 });
  assert.deepEqual(await state.execute({ bb }, { source }), { values: { a: 1 }, revision: 3 });
  assert.deepEqual(bb.calls.storageLocation, []);
});
