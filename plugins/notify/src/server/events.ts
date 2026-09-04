import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { notifyThread } from "./notify-thread.ts";
import { runTracker } from "./run-tracker.ts";
import { pluginSettings } from "./settings.ts";

export function registerEvents(bb: BbPluginApi): void {
  bb.events.on("thread.active", ({ thread }) => {
    runTracker(bb).started(thread.id);
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const settings = pluginSettings(bb);
    if (!settings.notifyOnIdle) {
      runTracker(bb).cancel(thread.id);
      return;
    }
    return notifyThread(bb, thread, "finished", lastAssistantText);
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    const settings = pluginSettings(bb);
    if (!settings.notifyOnFailed) {
      runTracker(bb).cancel(thread.id);
      return;
    }
    return notifyThread(bb, thread, "failed", error);
  });

  bb.events.on("thread.deleted", ({ thread }) => runTracker(bb).dropped(thread.id));
  bb.events.on("thread.archived", ({ thread }) => runTracker(bb).dropped(thread.id));
}
