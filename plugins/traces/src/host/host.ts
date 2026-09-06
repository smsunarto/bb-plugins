import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { resolve } from "node:path";
import { traceHostContract } from "../shared/host-contract.ts";
import type { TraceAdapter } from "../shared/model.ts";
import { TraceIndex } from "./index.ts";
import { sourceWatchPath } from "./ingest.ts";

type HostContext = Parameters<
  Parameters<typeof experimental_defineHostEntry<typeof traceHostContract>>[0]["handlers"]["status"]
>[1];
type HostState = {
  index: TraceIndex;
  timer: ReturnType<typeof setInterval>;
  watches: Array<{ dispose(): Promise<void> }>;
  watchEpoch: number;
  verifyPending: boolean;
  closed: boolean;
  lease: ReturnType<HostContext["experimental_retainWorker"]>;
  closePromise: Promise<void> | null;
};

export function createTraceHost(options: { adapters?: readonly TraceAdapter[] } = {}) {
  const indexes = new Map<string, HostState>();

  function scheduleScan(state: HostState, context: HostContext, verify = false): void {
    if (state.closed || context.lifecycle.signal.aborted) return;
    if (state.index.status().scanning) {
      state.verifyPending ||= verify;
      return;
    }
    void state.index
      .scan({ verify, signal: context.lifecycle.signal })
      .catch(() => undefined)
      .finally(() => {
        if (state.verifyPending) {
          state.verifyPending = false;
          scheduleScan(state, context, true);
        }
      });
  }

  async function refreshWatches(state: HostState, context: HostContext): Promise<void> {
    const epoch = ++state.watchEpoch;
    const previous = state.watches.splice(0);
    await Promise.all(previous.map((watch) => watch.dispose()));
    for (const root of state.index.status().roots) {
      if (!root.enabled || state.closed) continue;
      try {
        const watchPath = await sourceWatchPath(root.path);
        const watch = await context.experimental_watch(
          { rootPath: watchPath, debounceMs: 250 },
          (event) => {
            if (
              event.kind === "changed" &&
              watchPath !== root.path &&
              !event.changes.some((change) => resolve(watchPath, change.path) === root.path)
            )
              return;
            scheduleScan(state, context, event.kind === "rescan-required");
          },
        );
        if (state.closed || epoch !== state.watchEpoch) await watch.dispose();
        else state.watches.push(watch);
      } catch {
        // Missing roots are retried by reconciliation; the scanner reports their state.
      }
    }
  }

  function closeState(state: HostState): Promise<void> {
    if (state.closePromise) return state.closePromise;
    state.closed = true;
    state.watchEpoch += 1;
    clearInterval(state.timer);
    state.closePromise = (async () => {
      await Promise.all(state.watches.splice(0).map((watch) => watch.dispose()));
      await state.index.close();
      await state.lease.dispose();
    })();
    return state.closePromise;
  }

  function stateFor(context: HostContext, startScan = true): HostState {
    const dataDir = context.experimental_paths.dataDir;
    const existing = indexes.get(dataDir);
    if (existing) return existing;
    const index = new TraceIndex({ dataDir, adapters: options.adapters });
    let scans = 0;
    const state: HostState = {
      index,
      watches: [],
      watchEpoch: 0,
      verifyPending: false,
      closed: false,
      lease: context.experimental_retainWorker(),
      closePromise: null,
      timer: setInterval(() => {
        scans += 1;
        // Append probes are backed by a full integrity audit every ten minutes.
        scheduleScan(state, context, scans % 10 === 0);
        if (state.watches.length === 0) void refreshWatches(state, context);
      }, 60_000),
    };
    state.timer.unref();
    indexes.set(dataDir, state);
    context.lifecycle.signal.addEventListener(
      "abort",
      () => {
        void closeState(state).finally(() => indexes.delete(dataDir));
      },
      { once: true },
    );
    if (startScan) {
      scheduleScan(state, context);
      void refreshWatches(state, context);
    }
    return state;
  }

  return experimental_defineHostEntry({
    contract: traceHostContract,
    handlers: {
      status(_input, context) {
        return stateFor(context).index.status();
      },
      scan(input, context) {
        const state = stateFor(context);
        scheduleScan(state, context, input.verify);
        return state.index.status();
      },
      async configureSources(input, context) {
        const state = stateFor(context, false);
        state.verifyPending = false;
        await state.index.configureSources(input);
        void refreshWatches(state, context);
        scheduleScan(state, context, true);
        return state.index.status();
      },
      sessions(input, context) {
        return stateFor(context).index.sessions(input);
      },
      events(input, context) {
        return stateFor(context).index.events(input);
      },
      event(input, context) {
        return stateFor(context).index.event(input, context.signal);
      },
      raw(input, context) {
        return stateFor(context).index.raw(input, context.signal);
      },
    },
    async dispose() {
      await Promise.all([...indexes.values()].map(closeState));
      indexes.clear();
    },
  });
}

export default createTraceHost();
