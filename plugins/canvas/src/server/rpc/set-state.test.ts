import { test } from "bun:test";
import assert from "node:assert/strict";
import { stateKeyOf, type CanvasSource } from "../../shared/document.ts";
import { fakeBb } from "../fake-bb.ts";
import { setState } from "./set-state.ts";
import { state } from "./state.ts";

const source: CanvasSource = { kind: "host", hostId: "h", path: "/x/c.canvas.mdx" };

test("setState stores one key, bumps the revision, and publishes the signal", async () => {
  const bb = fakeBb({});
  const result = await setState.execute({ bb }, { source, key: "show-patch", value: false });
  assert.deepEqual(result, { values: { "show-patch": false }, revision: 1 });
  assert.deepEqual(await state.execute({ bb }, { source }), result);
  assert.deepEqual(bb.calls.published, [
    { channel: "canvas:state", payload: { stateKey: stateKeyOf(source), revision: 1 } },
  ]);
});

test("setState is idempotent for an unchanged value", async () => {
  const bb = fakeBb({});
  await setState.execute({ bb }, { source, key: "k", value: { a: [1, 2] } });
  const again = await setState.execute({ bb }, { source, key: "k", value: { a: [1, 2] } });
  assert.equal(again.revision, 1);
  assert.equal(bb.calls.published.length, 1);
});
