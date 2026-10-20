import { useEffect, useRef } from "react";
import {
  useRealtimeConnectionState,
  useSdk,
  type PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";

/** One `thread:changed` notification, as bb's realtime channel delivers it. */
export type ThreadChange = Parameters<
  Extract<Parameters<PluginBrowserBbSdk["subscribe"]>[0], { event: "thread:changed" }>["callback"]
>[0];

/** True when the change appended an event of one of `types`. bb names the
 *  appended types; a change that does not is treated as a match. */
export function appended(event: ThreadChange, types: readonly string[]): boolean {
  if (!event.changes.includes("events-appended")) return false;
  const appendedTypes: readonly string[] | undefined = event.metadata?.eventTypes;
  return appendedTypes === undefined || appendedTypes.some((type) => types.includes(type));
}

/**
 * Run `onChange` when `threadId` changes in a way `matches` accepts, and when
 * realtime reconnects, because changes sent while it was down are lost. This
 * is the app's only refresh trigger for server state derived from a thread's
 * events. Off while `enabled` is false.
 */
export function useThreadChanges(
  threadId: string | null,
  enabled: boolean,
  matches: (event: ThreadChange) => boolean,
  onChange: () => void,
): void {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const latest = useRef({ matches, onChange });
  latest.current = { matches, onChange };
  const live = enabled && threadId !== null;

  useEffect(() => {
    if (!live) return;
    return sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (event.id === threadId && latest.current.matches(event)) latest.current.onChange();
      },
    });
  }, [sdk, threadId, live]);

  const lastConnection = useRef(connection);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connection;
    if (live && connection === "connected" && previous !== "connected") latest.current.onChange();
  }, [connection, live]);
}
