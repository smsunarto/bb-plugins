// The look, act, wait loop: frame ids, condition waits, changed-only looks, and batches.
import { expect, test } from "bun:test";

import { parseReply } from "../src/server/browser.ts";
import { dragMoves, SauceError } from "../src/server/live.ts";
import { codeOf, fakeDevice } from "./fakes.ts";

const A = { threadId: "thr_a" };

async function started() {
  const fake = fakeDevice();
  await fake.core.start(A, { device: "Samsung Galaxy S23" });
  return fake;
}

test("each look gets the next frame id, and a touch aimed at an older frame is refused unsent", async () => {
  const { core, world } = await started();
  expect(await core.look(A)).toMatchObject({ frame: 1 });
  world.gray = 200;
  expect(await core.look(A)).toMatchObject({ frame: 2 });

  expect(await codeOf(core.tap(A, { x: 0.5, y: 0.5 }, { frame: 1 }))).toBe("stale_frame");
  expect(world.sent).toEqual([]);

  expect(await core.tap(A, { x: 0.5, y: 0.5 }, { frame: 2 })).toMatchObject({
    gesture: "tap",
    frame: 2,
  });
  expect(world.sent).toEqual(["tap 0.5 0.5"]);
});

test("a look says whether the screen changed, and --if-changed saves nothing for an unchanged one", async () => {
  const { core, world } = await started();
  const first = (await core.look(A)) as Record<string, unknown>;
  expect(first).toMatchObject({ frame: 1, changed: true });
  expect(first.path).toBeDefined();

  const same = (await core.look(A, { ifChanged: true })) as Record<string, unknown>;
  expect(same).toMatchObject({ frame: 1, changed: false, change: 0 });
  expect(same.path).toBeUndefined();
  expect(world.saved).toHaveLength(1);

  world.gray = 200;
  const moved = (await core.look(A, { ifChanged: true })) as Record<string, unknown>;
  expect(moved).toMatchObject({ frame: 2, changed: true });
  expect(moved.path).toBeDefined();
  expect(world.saved).toHaveLength(2);
});

test("wait stable returns once the screen holds still for two comparisons in a row", async () => {
  const { core, world } = await started();
  // An animation: every sample differs until the fourth, then the screen rests.
  world.onSample = (count) => void (world.gray = count < 4 ? count * 40 : 200);
  const began = world.now;
  const waited = await core.wait(A, { until: "stable", timeoutMs: 10_000 });
  expect(waited).toMatchObject({ condition: "stable", met: true });
  expect(waited.waited_ms).toBe(world.now - began);
  // Samples 4, 5 and 6 match: two still comparisons.
  expect(world.samples).toBe(6);
});

test("a screen that never holds still times out as a result, not an error", async () => {
  const { core, world } = await started();
  world.onSample = (count) => void (world.gray = (count * 40) % 256);
  const waited = await core.wait(A, { until: "stable", timeoutMs: 2_000 });
  expect(waited).toMatchObject({ met: false, timed_out: true });
  expect(waited.waited_ms).toBeGreaterThanOrEqual(2_000);
  expect(waited.waited_ms).toBeLessThan(2_500);
});

test("wait changed after a gesture compares with the screen before the gesture", async () => {
  const { core, world } = await started();
  await core.look(A);
  // The app reacts at once: by the first poll after the tap the new screen is already up.
  world.onGesture = () => void (world.gray = 200);
  const tapped = await core.tap(A, { x: 0.5, y: 0.5 }, { wait: "changed" });
  expect(tapped).toMatchObject({ gesture: "tap", wait: { condition: "changed", met: true } });
});

test("a tap that changes nothing reports the timed-out wait beside the landed gesture", async () => {
  const { core, world } = await started();
  await core.look(A);
  const tapped = await core.tap(A, { x: 0.5, y: 0.5 }, { wait: "changed", timeoutMs: 1_000 });
  expect(tapped).toMatchObject({
    gesture: "tap",
    wait: { met: false, timed_out: true, note: "The screen did not change." },
  });
  expect(world.sent).toEqual(["tap 0.5 0.5"]);
});

test("tap --wait --look waits first, then returns the new look and its frame", async () => {
  const { core, world } = await started();
  await core.look(A);
  world.onGesture = () => void (world.gray = 200);
  const tapped = await core.tap(A, { x: 0.9, y: 0.1 }, { wait: "stable", look: "full" });
  expect(tapped).toMatchObject({
    wait: { met: true },
    look: { frame: 2, changed: true, path: expect.stringMatching(/-after-tap\.png$/) },
  });
});

test("a session that ends during a wait frees the device", async () => {
  const { core, world, deps } = await started();
  await core.look(A);
  world.onSample = (count) => {
    if (count === 2) world.page = { ...world.page, kind: "session_ended" };
  };
  expect(await codeOf(core.wait(A, { until: "changed", timeoutMs: 5_000 }))).toBe("no_session");
  expect(deps.store.read()).toBeNull();
});

test("a batch runs its steps in order and stops at the first failure", async () => {
  const { core, world } = await started();
  await core.look(A);
  world.onGesture = () => void (world.gray = 200);
  const ran = await core.batch(A, [
    { do: "tap", x: 0.5, y: 0.9 },
    { do: "wait", until: "changed" },
    { do: "look", label: "lobby" },
    { do: "device", action: "rotate" },
    // The rotation cleared the frame, so this tap must not reach the device.
    { do: "tap", x: 0.1, y: 0.1 },
    { do: "look" },
  ]);
  expect(ran).toMatchObject({
    ok: false,
    completed: 4,
    total: 6,
    failed: { step: 5, code: "no_frame" },
  });
  expect(world.sent).toEqual(["tap 0.5 0.9", "menu Rotate Device"]);
  expect((ran.steps[1] as { met: boolean }).met).toBe(true);
  expect(ran.steps[2]).toMatchObject({ frame: 2 });
  // The run is saved for a caller that was killed before the command printed anything.
  expect(ran.record).toEndWith("-batch.json");
  expect(world.saved.at(-1)).toEndWith("-batch.json");
});

test("a batch's frame id guards its gestures until a look inside it sets a new frame", async () => {
  const { core, world } = await started();
  await core.look(A);
  await core.look(A);
  const stale = await core.batch(A, [{ do: "tap", x: 0.5, y: 0.5 }], { frame: 1 });
  expect(stale).toMatchObject({
    ok: false,
    completed: 0,
    failed: { step: 1, code: "stale_frame" },
  });
  expect(world.sent).toEqual([]);

  const fresh = await core.batch(
    A,
    [{ do: "tap", x: 0.5, y: 0.5 }, { do: "look" }, { do: "tap", x: 0.2, y: 0.2 }],
    { frame: 2 },
  );
  expect(fresh).toMatchObject({ ok: true, completed: 3 });
});

test("a batch whose caller went away stops before the next step", async () => {
  const { core, world } = await started();
  await core.look(A);
  const abort = new AbortController();
  world.onGesture = () => abort.abort();
  const ran = await core.batch({ ...A, signal: abort.signal }, [
    { do: "tap", x: 0.5, y: 0.5 },
    { do: "tap", x: 0.6, y: 0.6 },
  ]);
  expect(ran).toMatchObject({ ok: false, completed: 1, failed: { step: 2, code: "cancelled" } });
  expect(world.sent).toEqual(["tap 0.5 0.5"]);
});

test("only the holder may wait or batch", async () => {
  const { core } = await started();
  const b = { threadId: "thr_b" };
  expect(await codeOf(core.wait(b, { until: "stable" }))).toBe("held_by_other_thread");
  const ran = await core.batch(b, [{ do: "look" }]);
  expect(ran).toMatchObject({ ok: false, failed: { step: 1, code: "held_by_other_thread" } });
});

test("a drag's moves are evenly spaced, end on the target, and stay within 40 steps", () => {
  const moves = dragMoves({ x: 100, y: 100 }, { x: 500, y: 300 }, 300).filter((m) =>
    m.startsWith("mouse move"),
  );
  expect(moves).toHaveLength(12);
  expect(moves[0]).toBe("mouse move 133 117");
  expect(moves.at(-1)).toBe("mouse move 500 300");
  expect(
    dragMoves({ x: 0, y: 0 }, { x: 10, y: 10 }, 0).filter((m) => m.startsWith("mouse")),
  ).toHaveLength(2);
  expect(
    dragMoves({ x: 0, y: 0 }, { x: 10, y: 10 }, 5_000).filter((m) => m.startsWith("mouse")),
  ).toHaveLength(40);
});

test("a batch reply succeeds only when every entry did, and names the entry that failed", () => {
  const ok = parseReply(
    JSON.stringify([
      { command: ["mouse", "down"], success: true, error: null, result: { pressed: true } },
      {
        command: ["mouse", "up"],
        success: true,
        error: null,
        result: { lifecycle: { launched: true } },
      },
    ]),
  );
  expect(ok).toEqual({ success: true, data: { lifecycle: { launched: true } } });

  const failed = parseReply(
    JSON.stringify([
      { command: ["mouse", "move", "1", "2"], success: true, error: null, result: {} },
      { command: ["mouse", "down"], success: false, error: "page crashed", result: null },
    ]),
  );
  expect(failed?.success).toBe(false);
  expect(String(failed?.error)).toBe("step 2 of 2 (mouse down): page crashed");

  expect(parseReply('noise\n{"success":true,"data":{"result":1}}')).toEqual({
    success: true,
    data: { result: 1 },
  });
  expect(parseReply("not json")).toBeNull();
});

test("errors keep their code when a look after a gesture is cancelled", async () => {
  const { core, world } = await started();
  await core.look(A);
  world.failCapture = new SauceError("cancelled", "The command was cancelled.");
  expect(await codeOf(core.tap(A, { x: 0.5, y: 0.5 }, { look: "full" }))).toBe("cancelled");
});
