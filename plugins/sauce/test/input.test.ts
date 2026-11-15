// Fast looks, text and keys, per-step frames, and browser failures that carry a code.
import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import { BrowserCommandError } from "../src/server/browser.ts";
import { parseStep } from "../src/server/cli.ts";
import { pngEncode, pngPixels, pngSize, turnPixels } from "../src/server/png.ts";
import { registerSauce } from "../src/server/server.ts";
import { codeOf, fakeDevice } from "./fakes.ts";

const A = { threadId: "thr_a" };

async function started() {
  const fake = fakeDevice();
  await fake.core.start(A, { device: "Samsung Galaxy S23" });
  return fake;
}

function cli() {
  const fake = fakeDevice();
  const { bb, harness } = createFakePluginHost({
    pluginId: "sauce",
    agentSkillIds: ["sauce-live"],
  });
  registerSauce(bb, fake.deps);
  const json = async (argv: string[]) => {
    const result = await harness.runCli([...argv, "--json"], { threadId: "thr_a" });
    return { ...result, value: JSON.parse(result.stdout || "null") as Record<string, any> };
  };
  return { ...fake, json, harness };
}

test("a fast look reuses a measured rotation and still sets the frame touches refer to", async () => {
  const { core, world } = await started();
  expect(await core.look(A)).toMatchObject({ frame: 1, kind: "full", rotation: 90 });

  const fast = await core.look(A, { fast: true });
  expect(fast).toMatchObject({ frame: 2, kind: "fast", rotation: 90, width: 900, height: 415 });
  expect(world.captures).toBe(1);
  expect(world.sent).toEqual(["glance 90"]);
  expect(await core.tap(A, { x: 0.5, y: 0.5 }, { frame: 2 })).toMatchObject({ frame: 2 });
});

test("a fast look before any measured rotation is a full look, and says so", async () => {
  const { core, world } = await started();
  const first = (await core.look(A, { fast: true })) as { note?: string };
  expect(first).toMatchObject({ kind: "full", frame: 1 });
  expect(first.note).toContain("fast look needs a rotation");
  expect(world.glances).toBe(0);

  // A rotation that was only assumed is not one a fast look may reuse.
  world.reading = { candidates: [90, 270], best: 270, clear: false };
  const { core: other, world: unclear } = await started();
  unclear.reading = { candidates: [90, 270], best: 270, clear: false };
  await other.look(A);
  expect(await other.look(A, { fast: true })).toMatchObject({ kind: "full" });
  expect(unclear.glances).toBe(0);
});

test("after the screen may have turned, the next fast look is a full one again", async () => {
  for (const action of ["home", "restart_app", "rotate"] as const) {
    const { core, world } = await started();
    await core.look(A);
    await core.device(A, { action });
    expect(await core.look(A, { fast: true })).toMatchObject({ kind: "full" });
    expect(await core.look(A, { fast: true })).toMatchObject({ kind: "fast" });
    expect(world.glances).toBe(1);
  }
});

test("an unclear full look keeps a measured rotation usable for fast looks", async () => {
  const { core, world } = await started();
  await core.look(A);
  world.reading = { candidates: [90, 270], best: 270, clear: false };
  expect(await core.look(A)).toMatchObject({ rotation: 90, rotation_measured: false });
  expect(await core.look(A, { fast: true })).toMatchObject({ kind: "fast" });
});

test("looks of different kinds are not compared, so the first of a kind reads as changed", async () => {
  const { core } = await started();
  await core.look(A);
  // Same screen, but the page's video never matches the device's pixels exactly.
  const firstFast = (await core.look(A, { fast: true, ifChanged: true })) as Record<
    string,
    unknown
  >;
  expect(firstFast).toMatchObject({ changed: true, frame: 2 });
  expect(firstFast.change).toBeUndefined();
  const again = (await core.look(A, { fast: true, ifChanged: true })) as Record<string, unknown>;
  expect(again).toMatchObject({ changed: false, frame: 2 });
  expect(again.path).toBeUndefined();
});

test("tap --fast returns a fast look after the wait", async () => {
  const { json, world } = cli();
  await json(["start", "Samsung Galaxy S23"]);
  await json(["look"]);
  world.onGesture = () => void (world.gray = 200);
  const tapped = await json(["tap", "0.5", "0.5", "--wait", "changed", "--fast"]);
  expect(tapped.value).toMatchObject({ wait: { met: true }, look: { kind: "fast", frame: 2 } });
  const full = await json(["tap", "0.5", "0.5", "--look"]);
  expect(full.value.look).toMatchObject({ kind: "full", frame: 3 });
});

test("type sends the text as given, and key sends one named key", async () => {
  const { json, world, harness } = cli();
  await json(["start", "Samsung Galaxy S23"]);
  await json(["look"]);
  expect((await json(["type", "hello", "world"])).value).toEqual({ typed: 11 });
  // Text after `--` is never read as an option, so `--json` goes before it.
  const dashed = await harness.runCli(["type", "--json", "--", "--dashed text"], {
    threadId: "thr_a",
  });
  expect(JSON.parse(dashed.stdout)).toEqual({ typed: 13 });
  expect((await json(["key", "enter"])).value).toMatchObject({ key: "enter" });
  expect(world.sent).toEqual(["type hello world", "type --dashed text", "key enter"]);

  world.onGesture = () => void (world.gray = 200);
  const typed = await json(["type", "abc", "--wait", "changed", "--look"]);
  expect(typed.value).toMatchObject({ typed: 3, wait: { met: true }, look: { frame: 2 } });
});

test("type and key refuse bad input before the device is touched", async () => {
  const { json, world } = cli();
  await json(["start", "Samsung Galaxy S23"]);
  for (const argv of [["type"], ["type", "a\nb"], ["type", "x".repeat(501)], ["key", "f13"]]) {
    const refused = await json(argv);
    expect(refused.exitCode).toBe(1);
    expect(refused.value.error.code).toBe("invalid_value");
  }
  expect(world.sent).toEqual([]);
});

test("key back presses Android's BACK through the shell, and is refused on iOS", async () => {
  const { core, world } = await started();
  expect(await core.key(A, { key: "back" })).toMatchObject({ key: "back" });
  expect(world.sent).toEqual(["shell input keyevent 4"]);

  const lease = fakeDevice();
  await lease.core.start(A, { device: "iPhone 16 Pro" });
  const held = lease.deps.store.read();
  if (held) lease.deps.store.write({ ...held, device: "iPhone 16 Pro - iOS 27.0" });
  expect(await codeOf(lease.core.key(A, { key: "back" }))).toBe("unsupported");
  expect(lease.world.sent).toEqual([]);
});

test("a batch step may carry its own frame, text, and keys", async () => {
  expect(parseStep("tap 0.5 0.6 --frame 22")).toEqual({ do: "tap", x: 0.5, y: 0.6, frame: 22 });
  expect(parseStep("drag 0 0 1 1 --frame 3")).toMatchObject({ do: "drag", frame: 3 });
  expect(parseStep("type hello  --not-a-flag 1")).toEqual({
    do: "type",
    text: "hello  --not-a-flag 1",
  });
  expect(parseStep("key backspace")).toEqual({ do: "key", key: "backspace" });
  expect(parseStep("look --fast")).toEqual({ do: "look", fast: true });
  expect(() => parseStep("tap 0.5 0.6 --frame x")).toThrow("--frame");
  expect(() => parseStep("type")).toThrow("needs text");
  expect(() => parseStep("key f13")).toThrow("key takes");

  const { core, world } = await started();
  await core.look(A);
  await core.look(A);
  const stale = await core.batch(A, [{ do: "tap", x: 0.5, y: 0.5, frame: 1 }]);
  expect(stale).toMatchObject({ ok: false, failed: { step: 1, code: "stale_frame" } });
  expect(world.sent).toEqual([]);

  world.onGesture = () => void (world.gray += 60);
  const ran = await core.batch(A, [
    { do: "tap", x: 0.5, y: 0.5, frame: 2 },
    { do: "type", text: "abc" },
    { do: "wait", condition: "changed" },
    { do: "key", key: "enter" },
    { do: "look", fast: true },
  ]);
  expect(ran).toMatchObject({ ok: true, completed: 5 });
  expect(world.sent).toEqual(["tap 0.5 0.5", "type abc", "key enter", "glance 90"]);
});

test("a browser command that fails is a coded failure, not a crash", async () => {
  const { json, world, deps } = cli();
  await json(["start", "Samsung Galaxy S23"]);
  await json(["look"]);
  deps.page.tap = async () => {
    throw new BrowserCommandError("batch", "step 2 of 3 (mouse down): boom");
  };
  const tapped = await json(["tap", "0.5", "0.5"]);
  expect(tapped.exitCode).toBe(1);
  expect(tapped.value.error.code).toBe("browser_failed");
  expect(tapped.value.error.hint).toContain("bb sauce look");

  const batch = await json(["batch", "tap 0.5 0.5", "look"]);
  expect(batch.value).toMatchObject({ ok: false, failed: { step: 1, code: "browser_failed" } });
  expect(world.sent).toEqual([]);
});

test("a picture turns upright through a PNG round trip", async () => {
  // 3x2 RGB: the first pixel is the canvas's top-left corner.
  const canvas = {
    width: 3,
    height: 2,
    channels: 3,
    data: Uint8Array.from({ length: 18 }, (_, i) => i + 1),
  };
  const png = await pngEncode(canvas);
  expect(pngSize(png)).toEqual({ width: 3, height: 2 });
  expect((await pngPixels(png))?.data).toEqual(canvas.data);

  const upright = turnPixels(canvas, 90);
  expect([upright.width, upright.height]).toEqual([2, 3]);
  // A clockwise quarter turn carries the top-left corner to the top-right.
  expect([...upright.data.subarray(3, 6)]).toEqual([1, 2, 3]);
  for (const turn of [90, 180, 270])
    expect(turnPixels(turnPixels(canvas, turn), 360 - turn).data).toEqual(canvas.data);
});

test("upload sends a build that exists on the server, and refuses anything else unsent", async () => {
  const { json, world } = cli();
  const uploaded = await json(["upload", "/builds/bb-android.apk"]);
  expect(uploaded.value).toMatchObject({
    uploaded: "Uploads/bb-android.apk v1 • Build 1",
    megabytes: 72.2,
  });
  expect(world.sent).toEqual(["upload /builds/bb-android.apk"]);

  world.sent.length = 0;
  expect((await json(["upload", "/builds/notes.txt"])).value.error.code).toBe("invalid_value");
  const missing = await json(["upload", "/elsewhere/app.ipa"]);
  expect(missing.value.error.code).toBe("not_found");
  expect(missing.value.error.message).toContain("bb server machine");
  expect(world.sent).toEqual([]);
});

test("upload waits its turn: not while another thread holds the device", async () => {
  const fake = fakeDevice();
  await fake.core.start({ threadId: "thr_b" }, { device: "Samsung Galaxy S23" });
  expect(await codeOf(fake.core.upload(A, { path: "/builds/app.apk" }))).toBe(
    "held_by_other_thread",
  );
  expect(fake.world.sent).toEqual([]);
});
