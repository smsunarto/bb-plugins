import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The built-in thread list owns the folds shared by both sidebars. */
export const COLLAPSED_THREADS_KEY = "collapsedThreads";
const preferencesSchema = z.object({
  preferences: z.object({ collapsedThreads: z.array(z.string()).default([]) }),
});
const writtenSchema = z.object({ key: z.string(), value: z.array(z.string()) });
type Plugins = Pick<BbPluginApi["sdk"]["plugins"], "callRpc">;

/** How long one thread-list call may take before the store gives up on it. */
export const THREAD_LIST_CALL_TIMEOUT_MS = 5_000;
/** The first write, and one more when another sidebar's write overwrote it. */
const WRITE_ATTEMPTS = 2;

/** `threadIds` with `threadId` folded or open, every other fold kept in order. */
export function withThreadCollapsed(
  threadIds: readonly string[],
  threadId: string,
  collapsed: boolean,
): string[] {
  if (threadIds.includes(threadId) === collapsed) return [...threadIds];
  return collapsed ? [...threadIds, threadId] : threadIds.filter((id) => id !== threadId);
}

export function sameFolds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export interface CollapsedThreadsStoreOptions {
  /** Aborts every thread-list call in flight, e.g. when the plugin unloads. */
  signal?: AbortSignal;
  /**
   * Runs whenever a read or write finds folds that differ from the last ones
   * the store saw. The first read only sets the baseline.
   */
  onChange?: (threadIds: readonly string[]) => void;
}

export interface CollapsedThreadsStore {
  /** The stored folds, or this session's last successful read when thread-list fails. */
  list(): Promise<string[]>;
  /** The stored folds; rejects when thread-list cannot answer. */
  read(): Promise<string[]>;
  /** Folds or opens one family; resolves to the folds read after the write. */
  set(threadId: string, collapsed: boolean): Promise<string[]>;
}

/**
 * Settles with `call`, or rejects once the deadline passes or `lifetime`
 * aborts, even if `call` itself ignores its signal. A hung call must not stall
 * the queue behind it.
 */
async function withDeadline<T>(
  lifetime: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  lifetime?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(lifetime?.reason);
  lifetime?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`thread-list did not answer within ${THREAD_LIST_CALL_TIMEOUT_MS} ms`),
      ),
    THREAD_LIST_CALL_TIMEOUT_MS,
  );
  timer.unref?.();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  try {
    return await Promise.race([call(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    lifetime?.removeEventListener("abort", abort);
  }
}

/**
 * thread-list's fold preference, read and written one call at a time.
 *
 * thread-list replaces the whole list on every write and has no revision or
 * atomic toggle, so a write is a read and a set back to back with nothing
 * awaited between them, and it states the fold it wants rather than flipping
 * one. A re-read after the write catches another sidebar that wrote its own
 * stale list over ours, and the fold is put back on top of that list.
 *
 * Residual race: a write from bb's sidebar that lands between our read and our
 * set is overwritten without a trace. Closing it needs thread-list to accept an
 * expected revision or a single-fold toggle.
 */
export function createCollapsedThreadsStore(
  plugins: Plugins,
  { signal, onChange }: CollapsedThreadsStoreOptions = {},
): CollapsedThreadsStore {
  let known: string[] | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const remember = (threadIds: string[]): string[] => {
    const previous = known;
    known = threadIds;
    if (previous !== undefined && !sameFolds(previous, threadIds)) onChange?.(threadIds);
    return threadIds;
  };
  const fetchFolds = async () => {
    const result = await withDeadline(signal, (callSignal) =>
      plugins.callRpc({
        pluginId: "thread-list",
        method: "listPreferences",
        input: null,
        outputSchema: preferencesSchema,
        signal: callSignal,
      }),
    );
    return remember(result.preferences.collapsedThreads);
  };
  const storeFolds = async (value: string[]) => {
    const result = await withDeadline(signal, (callSignal) =>
      plugins.callRpc({
        pluginId: "thread-list",
        method: "setPreference",
        input: { key: COLLAPSED_THREADS_KEY, value },
        outputSchema: writtenSchema,
        signal: callSignal,
      }),
    );
    return remember(result.value);
  };
  // Reads queue with writes, so a read that began before a write can never
  // land after it and put the old list back.
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };

  const read = () => serialize(fetchFolds);
  return {
    read,
    async list() {
      try {
        return await read();
      } catch {
        return known ?? [];
      }
    },
    set(threadId, collapsed) {
      return serialize(async () => {
        let current = await fetchFolds();
        for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
          if (current.includes(threadId) === collapsed) return current;
          await storeFolds(withThreadCollapsed(current, threadId, collapsed));
          current = await fetchFolds();
        }
        return current;
      });
    },
  };
}
