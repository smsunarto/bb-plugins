import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { PermissionMode } from "./permission-modes";

/**
 * The permission mode picked on each thread, for the length of this page.
 *
 * BB keeps a thread composer's mode in the composer's own state and resets it to the thread's
 * last sent mode when you open another thread, and its thread API offers no permission mode
 * to write. So the picker keeps the pick here and restores it when the thread opens again.
 * An entry goes once a turn starts on the thread, from any client, since BB then resets the
 * composer to that turn's mode, and when BB reports the thread deleted.
 */
const picks = new Map<string, { mode: PermissionMode; unsubscribe(): void }>();

export function keptPermissionMode(threadId: string): PermissionMode | undefined {
  return picks.get(threadId)?.mode;
}

export function keepPermissionMode(
  sdk: Pick<PluginBrowserBbSdk, "subscribe">,
  threadId: string,
  mode: PermissionMode,
): void {
  const kept = picks.get(threadId);
  if (kept) {
    kept.mode = mode;
    return;
  }
  const entry = { mode, unsubscribe: () => {} };
  picks.set(threadId, entry);
  entry.unsubscribe = sdk.subscribe({
    event: "thread:changed",
    threadId,
    callback: (event) => {
      const turnStarted = event.metadata?.eventTypes?.includes("turn/started") ?? false;
      if (turnStarted || event.changes.includes("thread-deleted")) forgetPermissionMode(threadId);
    },
  });
}

export function forgetPermissionMode(threadId: string): void {
  picks.get(threadId)?.unsubscribe();
  picks.delete(threadId);
}

/** For tests: forgets every thread's pick. */
export function forgetAllPermissionModes(): void {
  for (const threadId of picks.keys()) forgetPermissionMode(threadId);
}
