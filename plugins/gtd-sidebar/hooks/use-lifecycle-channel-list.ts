import { useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { refreshRetryDelayMs } from "@/lib/lifecycle";

const SHELF_GATE_MS = 250;
const LIFECYCLE_BATCH_MS = 50;

type ScheduledRead =
  | { kind: "batch"; timer: ReturnType<typeof setTimeout> }
  | {
      kind: "retry";
      timer: ReturnType<typeof setTimeout>;
      revision: number;
      attempt: number;
    };

type RefreshState =
  | { kind: "active"; revision: number; scheduled: ScheduledRead | null }
  | { kind: "disposed" };

type RefreshMode = "batch" | "immediate";

/**
 * Keeps a list current across lifecycle publishes and socket reconnects.
 * Failed reads preserve visible rows. Readiness opens on the first answer or
 * after 250 ms because `rpc.call` can stay pending indefinitely.
 */
export function useLifecycleChannelList<T>(
  load: () => Promise<T>,
  apply: (result: T) => void,
): boolean {
  const [ready, setReady] = useState(false);
  const refresh = useRef<((mode: RefreshMode) => void) | null>(null);

  useEffect(() => {
    let state: RefreshState = { kind: "active", revision: 0, scheduled: null };

    const isCurrent = (revision: number): boolean =>
      state.kind === "active" && state.revision === revision;

    const clearScheduled = (): void => {
      if (state.kind !== "active" || state.scheduled === null) return;
      clearTimeout(state.scheduled.timer);
      state.scheduled = null;
    };

    const run = async (revision: number, attempt: number): Promise<void> => {
      if (!isCurrent(revision)) return;
      try {
        const result = await load();
        if (isCurrent(revision)) apply(result);
      } catch {
        if (state.kind !== "active" || !isCurrent(revision)) return;
        const delay = refreshRetryDelayMs(attempt);
        if (delay === null) return;
        const retry: Extract<ScheduledRead, { kind: "retry" }> = {
          kind: "retry",
          revision,
          attempt: attempt + 1,
          timer: setTimeout(() => {
            if (state.kind !== "active" || state.scheduled !== retry) return;
            state.scheduled = null;
            void run(retry.revision, retry.attempt);
          }, delay),
        };
        state.scheduled = retry;
      } finally {
        if (state.kind === "active") setReady(true);
      }
    };

    const invalidate = (mode: RefreshMode): void => {
      if (state.kind !== "active") return;
      // Invalidate before the batch starts so an older response cannot apply
      // during the batching window.
      state.revision += 1;
      if (mode === "batch" && state.scheduled?.kind === "batch") return;
      clearScheduled();
      if (mode === "immediate") {
        void run(state.revision, 0);
        return;
      }
      const batch: ScheduledRead = {
        kind: "batch",
        timer: setTimeout(() => {
          if (state.kind !== "active" || state.scheduled !== batch) return;
          state.scheduled = null;
          void run(state.revision, 0);
        }, LIFECYCLE_BATCH_MS),
      };
      state.scheduled = batch;
    };

    refresh.current = invalidate;
    invalidate("immediate");
    return () => {
      const scheduled = state.kind === "active" ? state.scheduled : null;
      state = { kind: "disposed" };
      if (scheduled !== null) clearTimeout(scheduled.timer);
      if (refresh.current === invalidate) refresh.current = null;
    };
  }, [apply, load]);

  useRealtime("lifecycle", () => {
    refresh.current?.("batch");
  });

  useEffect(() => {
    if (ready) return;
    let active = true;
    const timer = setTimeout(() => {
      if (active) setReady(true);
    }, SHELF_GATE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ready]);

  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (previous === "reconnecting" && connectionState === "connected") {
      refresh.current?.("immediate");
    }
  }, [connectionState]);

  return ready;
}
