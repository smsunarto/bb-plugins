// `bb sauce` through the plugin host: argument parsing, the thread rule, and result shapes.
import { expect, onTestFinished, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import { fraction, milliseconds, parseStep, render } from "../src/server/cli.ts";
import { registerSauce } from "../src/server/server.ts";
import { fakeDevice } from "./fakes.ts";

function cli() {
  const fake = fakeDevice();
  const { bb, harness } = createFakePluginHost({
    pluginId: "sauce",
    agentSkillIds: ["sauce-live"],
  });
  // Disposing removes the fake host's storage dir.
  onTestFinished(() => harness.lifecycle.dispose());
  registerSauce(bb, fake.deps);
  const run = (argv: string[], threadId: string | null = "thr_a") =>
    harness.runCli(argv, threadId ? { threadId } : {});
  const json = async (argv: string[], threadId: string | null = "thr_a") => {
    const result = await run([...argv, "--json"], threadId);
    return { ...result, value: JSON.parse(result.stdout || "null") as Record<string, any> };
  };
  return { ...fake, run, json };
}

test("help lists every command without touching the device", async () => {
  const { run, world } = cli();
  const help = await run(["--help"], null);
  expect(help.exitCode).toBe(0);
  for (const name of [
    "status",
    "apps",
    "devices",
    "start",
    "defaults",
    "look",
    "tap",
    "drag",
    "wait",
    "batch",
    "device",
    "shell",
    "log",
    "end",
  ])
    expect(help.stdout).toContain(name);
  const tap = await run(["tap", "--help"], null);
  expect(tap.stdout).toContain("--frame");
  expect(tap.stdout).toContain("--wait");
  expect(world.sent).toEqual([]);
});

test("a shell that names no thread cannot hold the device, but may read the status", async () => {
  const { json } = cli();
  const start = await json(["start", "Samsung Galaxy S23"], null);
  expect(start.exitCode).toBe(1);
  expect(start.value).toMatchObject({ ok: false, error: { code: "no_thread" } });
  expect(start.value.error.hint).toContain("BB_THREAD_ID");

  // A typo is reported as a typo even there, not as the missing thread.
  expect((await json(["tap", "1.5", "0.5"], null)).value.error.code).toBe("invalid_value");

  const status = await json(["status"], null);
  expect(status.exitCode).toBe(0);
  expect(status.value.state).toBe("ready");
});

test("the loop runs end to end: start, look, tap with a frame, wait, look, end", async () => {
  const { json, world } = cli();
  expect((await json(["devices", "Galaxy"])).value.devices[0].name).toBe("Samsung Galaxy S23");
  const start = await json(["start", "Samsung Galaxy S23", "--os", "Android 16"]);
  expect(start.value.device).toBe("Samsung Galaxy S23 - Android 16");

  const look = await json(["look", "--label", "title"]);
  expect(look.value).toMatchObject({ frame: 1, width: 2340, height: 1080 });
  expect(look.value.path).toEndWith("-title.png");

  world.onGesture = () => void (world.gray = 200);
  const tap = await json(["tap", "0.93", "0.07", "--frame", "1", "--wait", "stable", "--look"]);
  expect(tap.exitCode).toBe(0);
  expect(tap.value).toMatchObject({
    gesture: "tap",
    from: { x: 0.93, y: 0.07 },
    wait: { met: true },
    look: { frame: 2, changed: true },
  });

  const drag = await json(["drag", ".5", ".8", ".5", ".2", "--duration", "400ms", "--hold", "2s"]);
  expect(drag.value.gesture).toBe("drag");
  expect(world.sent).toEqual(["tap 0.93 0.07", "drag 0.5 0.8 0.5 0.2 400 2000"]);

  expect((await json(["end"])).value).toEqual({ ended: true, released: true });
});

test("a refused command reports its code and hint, and sends nothing", async () => {
  const { json, run, world } = cli();
  await run(["start", "Samsung Galaxy S23"]);
  const early = await json(["tap", "0.5", "0.5"]);
  expect(early.exitCode).toBe(1);
  expect(early.value.error).toMatchObject({ code: "no_frame" });
  expect(early.value.error.hint).toContain("bb sauce look");

  await run(["look"]);
  await run(["look"]);
  const stale = await json(["tap", "0.5", "0.5", "--frame", "1"]);
  expect(stale.value.error.code).toBe("stale_frame");

  const other = await json(["look"], "thr_b");
  expect(other.value.error.code).toBe("held_by_other_thread");

  const outside = await json(["tap", "1.5", "0.5"]);
  expect(outside.exitCode).toBe(1);
  expect(outside.value.error.code).toBe("invalid_value");
  expect(world.sent).toEqual([]);
});

test("a batch with a typo in any step sends nothing", async () => {
  const { json, run, world } = cli();
  await run(["start", "Samsung Galaxy S23"]);
  await run(["look"]);
  const typo = await json(["batch", "tap 0.5 0.5", "wait stabel", "look"]);
  expect(typo.exitCode).toBe(1);
  expect(typo.value.error.code).toBe("invalid_value");
  expect(world.sent).toEqual([]);
});

test("a batch prints every finished step and exits 1 when one fails", async () => {
  const { json, run, world } = cli();
  await run(["start", "Samsung Galaxy S23"]);
  await run(["look"]);
  world.onGesture = () => void (world.gray = 200);
  const ok = await json([
    "batch",
    "tap 0.5 0.9 --hold 500ms",
    "wait changed --timeout 5s",
    "look --label lobby",
  ]);
  expect(ok.exitCode).toBe(0);
  expect(ok.value).toMatchObject({ ok: true, completed: 3, total: 3 });
  expect(ok.value.steps[2].path).toEndWith("-lobby.png");
  expect(world.sent).toEqual(["tap 0.5 0.9 hold 500"]);

  const failed = await json(["batch", "device rotate", "tap 0.1 0.1", "look"]);
  expect(failed.exitCode).toBe(1);
  expect(failed.value).toMatchObject({
    ok: false,
    completed: 1,
    failed: { step: 2, code: "no_frame" },
  });
});

test("shell passes the command through, and log greps the saved device log", async () => {
  const { json, run, world } = cli();
  await run(["start", "Samsung Galaxy S23"]);
  // Flags of the device command would be read as bb sauce options unless quoted or after `--`.
  const quoted = await json(["shell", "am start -n gg.argus.rampage/.Main"]);
  expect(quoted.value).toMatchObject({
    command: "am start -n gg.argus.rampage/.Main",
    output: "ok",
  });
  const passed = await run(["shell", "--json", "--", "input", "keyevent", "4"]);
  expect(JSON.parse(passed.stdout)).toMatchObject({ command: "input keyevent 4" });
  expect(world.sent).toEqual([
    "shell am start -n gg.argus.rampage/.Main",
    "shell input keyevent 4",
  ]);

  const log = await json(["log", "--grep", "unity"]);
  expect(log.value.matches).toEqual(["Unity boom"]);
  expect(log.value.path).toEndWith("-device.log");
});

test("plain output is readable key: value lines", async () => {
  const { run } = cli();
  await run(["start", "Samsung Galaxy S23"]);
  const look = await run(["look"]);
  expect(look.stdout).toContain("frame: 1");
  expect(look.stdout).toContain("rotation: 90");
  expect(render({ a: 1, list: [{ b: 2 }, "c"], nested: { d: true }, gone: undefined })).toBe(
    'a: 1\nlist:\n  - {"b":2}\n  - c\nnested:\n  d: true',
  );
});

test("batch steps parse in the same words as the standalone commands", () => {
  expect(parseStep("tap .9 .1 --hold 2s")).toEqual({ do: "tap", x: 0.9, y: 0.1, holdMs: 2000 });
  expect(parseStep("drag 0.5 0.8 0.5 0.2 --duration 300 --hold 1s")).toEqual({
    do: "drag",
    x: 0.5,
    y: 0.8,
    toX: 0.5,
    toY: 0.2,
    durationMs: 300,
    holdMs: 1000,
  });
  expect(parseStep("wait changed --timeout 30s")).toEqual({
    do: "wait",
    until: "changed",
    timeoutMs: 30_000,
  });
  expect(parseStep("look --label lobby --if-changed")).toEqual({
    do: "look",
    label: "lobby",
    ifChanged: true,
  });
  expect(parseStep("device restart-app")).toEqual({ do: "device", action: "restart_app" });
  for (const bad of [
    "tap 0.5",
    "tap 0.5 1.2",
    "swipe up",
    "wait forever",
    "wait stable --timeout 5m",
    "look --frame 2",
    "device reboot",
    "",
  ])
    expect(() => parseStep(bad), bad).toThrow();
});

test("coordinates and durations reject values outside their range", () => {
  expect(fraction("0", "x")).toBe(0);
  expect(fraction("1", "x")).toBe(1);
  for (const bad of ["-0.1", "1.01", "abc", "", "50%"])
    expect(() => fraction(bad, "x"), bad).toThrow();
  expect(milliseconds("250", "--hold", 30_000)).toBe(250);
  expect(milliseconds("1.5s", "--hold", 30_000)).toBe(1500);
  expect(() => milliseconds("31s", "--hold", 30_000)).toThrow();
});
