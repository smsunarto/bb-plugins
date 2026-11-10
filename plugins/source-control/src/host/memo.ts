/**
 * One read shared by every caller that asks while it runs, ported from
 * `plugins/gitbutler/src/shared/memo.ts` without its time-to-live: nothing
 * is handed out once its read has answered. A caller that gives up stops
 * waiting, and the read itself stops once nobody waits for it. `clear`
 * forgets reads still running, so a caller after a write starts a new one.
 */
type Entry = { promise: Promise<unknown>; controller: AbortController; waiting: number };

const entries = new Map<string, Entry>();

function start(key: string, load: (signal: AbortSignal) => Promise<unknown>): Entry {
  const controller = new AbortController();
  const entry: Entry = { controller, waiting: 0, promise: Promise.resolve() };
  const done = () => {
    if (entries.get(key) === entry) entries.delete(key);
  };
  entry.promise = load(controller.signal).finally(done);
  // Every caller may have left before it fails.
  entry.promise.catch(() => undefined);
  entries.set(key, entry);
  return entry;
}

function wait(key: string, entry: Entry, signal: AbortSignal): Promise<unknown> {
  entry.waiting += 1;
  let leave = () => {};
  const left = new Promise<never>((_resolve, reject) => {
    leave = () => {
      entry.waiting -= 1;
      if (entry.waiting === 0) {
        if (entries.get(key) === entry) entries.delete(key);
        entry.controller.abort(signal.reason);
      }
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", leave, { once: true });
  });
  return Promise.race([entry.promise, left]).finally(() =>
    signal.removeEventListener("abort", leave),
  );
}

/** A read that callers asking while it runs share, and nobody after. */
export function share<T>(
  key: string,
  signal: AbortSignal,
  load: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  const entry = entries.get(key) ?? start(key, load);
  return wait(key, entry, signal) as Promise<T>;
}

/** Something changed the repositories: no read started before now is handed out again. */
export function forget(): void {
  entries.clear();
}
