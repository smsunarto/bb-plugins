import { expect, mock, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import { registerCompletionSound } from "../src/server/lib/completion-sound.ts";

const thread = makeThreadResponse({ id: "sound-thread" });

test("plays on each idle transition, but not activation or failure", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  const play = mock(async (_signal: AbortSignal) => {});
  registerCompletionSound(bb, play);
  try {
    await harness.behavior.emitThreadEvent("thread.active", { thread });
    await harness.behavior.emitThreadEvent("thread.failed", { thread, error: "failed" });
    expect(play).not.toHaveBeenCalled();
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
    await harness.behavior.emitThreadEvent("thread.active", { thread });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "done again",
    });
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[0]?.[0].aborted).toBe(false);
  } finally {
    await harness.lifecycle.dispose();
  }
  expect(play.mock.calls[0]?.[0].aborted).toBe(true);
});

test("playback failure does not fail the event or prevent later playback", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  const play = mock(async (_signal: AbortSignal) => {
    throw new Error("sound unavailable");
  });
  registerCompletionSound(bb, play);
  try {
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
    expect(play).toHaveBeenCalledTimes(2);
    expect(harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("sound unavailable"),
        }),
      ]),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
