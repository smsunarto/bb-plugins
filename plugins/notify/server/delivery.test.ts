import { test } from "node:test";
import assert from "node:assert/strict";

import { deliver, macOsNotificationArguments, type NativeNotification } from "./delivery.ts";
import { createFakeContext } from "./fake-context.ts";

test("deliver formats one direct macOS notification", async () => {
  const ctx = createFakeContext({ settings: { sound: "Glass" } });
  const calls: NativeNotification[] = [];
  const sent = await deliver(
    ctx.bb,
    {
      project: "Acme",
      heading: "Build",
      message: "finished",
    },
    async (notification) => {
      calls.push(notification);
    },
  );

  assert.equal(sent, true);
  assert.deepEqual(calls, [
    {
      title: "Build",
      body: "[Acme] finished",
      soundName: "Glass",
    },
  ]);
});

test("deliver reports a native sender failure without queueing", async () => {
  const ctx = createFakeContext();
  const sent = await deliver(
    ctx.bb,
    { project: null, heading: "bb", message: "hello" },
    async () => {
      throw new Error("denied");
    },
  );
  assert.equal(sent, false);
});

test("macOS delivery passes untrusted text as argv, not AppleScript", () => {
  const title = `Build "quoted"`;
  const body = `done\nend run\ndo shell script "false"`;
  const args = macOsNotificationArguments({
    title,
    body,
    soundName: "Ping",
  });

  assert.equal(args[0], "-e");
  assert.ok(!args[1]?.includes(title));
  assert.ok(!args[1]?.includes(body));
  assert.deepEqual(args.slice(2), [title, body, "Ping"]);
});
