// The thread lifecycle listeners. All filtering, dedupe, and delivery logic
// lives in `context.notifyThread`; this module only maps events onto it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { Context } from "./context.ts";

export function registerEvents(bb: BbPluginApi, context: Context): void {
  bb.events.on("thread.active", ({ thread }) => {
    context.rememberStart(thread.id);
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!context.settings().notifyOnIdle) {
      context.clearStart(thread.id);
      return;
    }
    return context.notifyThread(thread, "finished", lastAssistantText);
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    if (!context.settings().notifyOnFailed) {
      context.clearStart(thread.id);
      return;
    }
    return context.notifyThread(thread, "failed", error);
  });

  bb.events.on("thread.deleted", ({ thread }) => context.forget(thread.id));
  bb.events.on("thread.archived", ({ thread }) => context.forget(thread.id));
}
