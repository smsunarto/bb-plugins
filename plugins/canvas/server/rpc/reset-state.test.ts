import { test } from "bun:test";
import assert from "node:assert/strict";
import { stateKeyOf, type CanvasSource } from "../../shared/document.ts";
import { fakeBb } from "../fake-bb.ts";
import { kvKeyOf } from "../state-store.ts";
import { resetState } from "./reset-state.ts";
import { setState } from "./set-state.ts";

const source: CanvasSource = { kind: "workspace", environmentId: "e", path: "c.canvas.mdx" };

test("resetState deletes the row and publishes like setState", async () => {
  const bb = fakeBb({});
  await setState.execute({ bb }, { source, key: "a", value: 1 });
  const result = await resetState.execute({ bb }, { source });
  assert.deepEqual(result, { values: {}, revision: 2 });
  assert.equal(await bb.storage.kv.get(kvKeyOf(source)), undefined);
  assert.deepEqual(bb.calls.published.at(-1), {
    channel: "canvas:state",
    payload: { stateKey: stateKeyOf(source), revision: 2 },
  });
});
