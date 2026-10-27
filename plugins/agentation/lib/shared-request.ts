// One request per key at a time, shared by every component that asks.
//
// An `annotations` broadcast reaches every mounted review panel, panel header,
// and staged-annotations action in the same tick, and each used to send its own request.
// Calls made before a request starts join it. A call made while one is in
// flight gets one follow-up that starts after it, because the in-flight answer
// may predate the change the caller just heard about; later callers join that
// follow-up, so a burst of broadcasts costs at most two requests per key.

type Slot = { queued: Promise<unknown> | null; running: Promise<unknown> | null };

const slots = new Map<string, Slot>();

export function sharedRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  let slot = slots.get(key);
  if (slot === undefined) {
    slot = { queued: null, running: null };
    slots.set(key, slot);
  }
  if (slot.queued !== null) return slot.queued as Promise<T>;
  const owner = slot;
  const queued = (async () => {
    // Let every caller in this tick join before the request goes out.
    await Promise.resolve();
    if (owner.running !== null) await owner.running.catch(() => undefined);
    owner.queued = null;
    const running = load();
    owner.running = running;
    try {
      return await running;
    } finally {
      if (owner.running === running) owner.running = null;
      if (owner.queued === null && owner.running === null && slots.get(key) === owner) {
        slots.delete(key);
      }
    }
  })();
  owner.queued = queued;
  return queued;
}

/** The `type` an `annotations` broadcast names: `annotations`, `routing`, or
 *  `config`. Null when the payload does not say, which callers treat as
 *  anything. */
export function broadcastType(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}
