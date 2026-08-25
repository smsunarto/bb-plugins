import { test } from "node:test";
import assert from "node:assert/strict";

import { createRunTracker } from "./run-tracker.ts";

test("notifyOnce reserves the dedupe slot before deliver and rolls it back on throw", async () => {
  const tracker = createRunTracker(() => 1_000);
  let calls = 0;
  await assert.rejects(
    () =>
      tracker.notifyOnce("th", 0, async () => {
        calls += 1;
        throw new Error("persist failed");
      }),
    /persist failed/,
  );
  assert.equal(calls, 1);
  const second = await tracker.notifyOnce("th", 0, async () => "ok");
  assert.deepEqual(second, { delivered: true, value: "ok" });
});

test("notifyOnce collapses two calls inside the dedupe window", async () => {
  const tracker = createRunTracker(() => 1_000);
  assert.deepEqual(await tracker.notifyOnce("th", 0, async () => 1), {
    delivered: true,
    value: 1,
  });
  assert.deepEqual(await tracker.notifyOnce("th", 0, async () => 2), {
    delivered: false,
    reason: "deduped",
  });
});
