import { useEffect, useRef } from "react";
import { useSdk, type PluginBrowserBbSdk, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { applySelection } from "./composer-settings/apply-selection";
import type { PermissionInfo } from "./model-picker/catalog";
import { resolvePermissionMode, type PermissionMode } from "./permission-modes";

/**
 * The permission mode chosen on each thread, for the length of this page.
 *
 * BB keeps a thread composer's mode in the composer's own state and resets it to the thread's
 * last sent mode whenever the thread opens again, and its thread API offers no permission mode
 * to write. So a mode chosen on a thread, from this picker, a `#` keyword or BB's own controls,
 * is kept here with the mode BB showed when the thread opened (`baseline`), and put back when
 * the thread opens again, but only while BB still opens it at that baseline. Any other value
 * means a turn was sent since, so the kept mode gives way to BB's. An entry also goes once BB
 * reports a turn started on the thread, and when it reports the thread deleted. A turn sent at
 * the baseline mode while this page heard nothing would pass the check, so when BB's realtime
 * connection comes back after a drop, every entry kept before the drop goes.
 */
interface Kept {
  mode: PermissionMode;
  baseline: PermissionMode;
  /** When the mode was last kept, in `connection` epochs. */
  epoch: number;
  unsubscribe(): void;
}
const picks = new Map<string, Kept>();
/** Unsubscribes from BB's connection state, held while anything is kept. */
let stopWatchingConnection: (() => void) | null = null;
/** Counts connection drops; `dropped` is the epoch of the drop not yet reconnected. */
const connection = { epoch: 0, dropped: null as number | null };

function watchConnection(sdk: Subscriber) {
  if (stopWatchingConnection) return;
  // BB replays its last connection state to a new listener first.
  let replay = true;
  stopWatchingConnection = sdk.subscribe({
    event: "realtime:connection",
    callback: (event) => {
      const first = replay;
      replay = false;
      if (event.state !== "connected") {
        if (connection.dropped === null) {
          connection.dropped = connection.epoch;
          connection.epoch += 1;
        }
        // Already down when watching began, so all that is kept was kept during the drop.
        if (first) for (const kept of picks.values()) kept.epoch = connection.epoch;
        return;
      }
      if (connection.dropped === null) return;
      const { dropped } = connection;
      connection.dropped = null;
      for (const [threadId, kept] of picks) {
        if (kept.epoch <= dropped) forgetPermissionMode(threadId);
      }
    },
  });
}

type Subscriber = Pick<PluginBrowserBbSdk, "subscribe">;

export function keptPermissionMode(threadId: string): PermissionMode | undefined {
  return picks.get(threadId)?.mode;
}

function keep(sdk: Subscriber, threadId: string, mode: PermissionMode, baseline: PermissionMode) {
  const kept = picks.get(threadId);
  // Back at the mode BB opens the thread with: nothing to put back.
  if (mode === (kept?.baseline ?? baseline)) {
    forgetPermissionMode(threadId);
    return;
  }
  if (kept) {
    kept.mode = mode;
    kept.epoch = connection.epoch;
    return;
  }
  const entry: Kept = { mode, baseline, epoch: connection.epoch, unsubscribe: () => {} };
  picks.set(threadId, entry);
  watchConnection(sdk);
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
  if (picks.size > 0) return;
  stopWatchingConnection?.();
  stopWatchingConnection = null;
  connection.dropped = null;
}

/** For tests: forgets every thread's mode. */
export function forgetAllPermissionModes(): void {
  for (const threadId of picks.keys()) forgetPermissionMode(threadId);
}

/** One opening of a thread composer, as this hook has followed it. */
interface Arrival {
  key: string;
  /** Waiting for the machine's limit, restoring through BB, or following changes. */
  phase: "waiting" | "restoring" | "done";
  /** The mode BB opened the thread with. */
  arrival: PermissionMode;
  /** The mode last seen, so a change can be told apart. */
  seen: PermissionMode;
}

/**
 * Keeps the thread composer's permission mode across thread switches; see `Kept`. Restores
 * without a message, since the user asked for nothing, settled under the machine's limit.
 */
export function useKeptPermissionMode(
  composer: PluginComposerApi,
  editable: boolean,
  info: PermissionInfo | undefined,
): void {
  const sdk = useSdk();
  const { key } = composer;
  const threadId = editable && composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const value = composer.selection?.permissionMode ?? null;
  const provider = info?.provider ?? null;
  const ceiling = info?.ceiling ?? null;
  const state = useRef<Arrival | null>(null);
  const composerRef = useRef(composer);
  useEffect(() => {
    composerRef.current = composer;
  });

  useEffect(() => {
    if (threadId === null || value === null) return;
    let current = state.current;
    if (current?.key !== key) {
      current = state.current = { key, phase: "waiting", arrival: value, seen: value };
    }
    const { arrival } = current;
    const record = (mode: PermissionMode) => keep(sdk, threadId, mode, arrival);
    if (current.phase === "restoring") return;
    if (current.phase === "done") {
      if (value !== current.seen) record(value);
      state.current = { ...current, seen: value };
      return;
    }
    // Waiting. A change made before the machine answered is the user's latest choice.
    if (value !== arrival) {
      state.current = { ...current, phase: "done", seen: value };
      record(value);
      return;
    }
    const kept = picks.get(threadId);
    // Nothing kept, or the kept mode is already showing, as after a remount.
    if (!kept || kept.mode === value) {
      state.current = { ...current, phase: "done" };
      return;
    }
    // BB opened the thread at another mode than the kept one was chosen over: a turn was sent.
    if (kept.baseline !== value) {
      forgetPermissionMode(threadId);
      state.current = { ...current, phase: "done" };
      return;
    }
    if (!provider || ceiling === null) return;
    const target = resolvePermissionMode(kept.mode, provider.modes, ceiling);
    if (target === value) {
      state.current = { ...current, phase: "done" };
      return;
    }
    state.current = { ...current, phase: "restoring" };
    void applySelection(composerRef.current, { permissionMode: target }).then(({ applied }) => {
      const now = state.current;
      if (now?.key === key && now.phase === "restoring") {
        state.current = { ...now, phase: "done", seen: applied?.permissionMode ?? value };
      }
      return applied;
    });
  }, [ceiling, key, provider, sdk, threadId, value]);
}
