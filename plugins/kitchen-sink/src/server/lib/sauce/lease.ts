/**
 * The Sauce Labs account has one live-device slot and the server drives one
 * shared browser tab, so one thread at a time may hold the device. The lease
 * lives in plugin storage so a plugin reload does not forget who holds it.
 */
export type SauceLease = {
  threadId: string;
  acquiredAt: number;
  lastUsedAt: number;
  device: string | null;
  /** Clockwise degrees that turn the session canvas upright; null until a screenshot measures it. */
  rotation: number | null;
};

export interface LeaseStore {
  read(): SauceLease | null;
  write(lease: SauceLease | null): void;
}

/** A lease unused this long is abandoned; another thread may take the device over. */
export const LEASE_IDLE_MS = 15 * 60 * 1000;

export type LeaseCheck =
  | { kind: "free" }
  | { kind: "mine"; lease: SauceLease }
  | { kind: "held"; lease: SauceLease; idleMs: number }
  | { kind: "abandoned"; lease: SauceLease; idleMs: number };

export function checkLease(store: LeaseStore, threadId: string, now: number): LeaseCheck {
  const lease = store.read();
  if (lease === null) return { kind: "free" };
  if (lease.threadId === threadId) return { kind: "mine", lease };
  const idleMs = now - lease.lastUsedAt;
  return idleMs >= LEASE_IDLE_MS
    ? { kind: "abandoned", lease, idleMs }
    : { kind: "held", lease, idleMs };
}

export function acquireLease(store: LeaseStore, threadId: string, now: number): SauceLease {
  const lease: SauceLease = {
    threadId,
    acquiredAt: now,
    lastUsedAt: now,
    device: null,
    rotation: null,
  };
  store.write(lease);
  return lease;
}

export function touchLease(
  store: LeaseStore,
  patch: Partial<Omit<SauceLease, "threadId">>,
  now: number,
) {
  const lease = store.read();
  if (lease === null) return null;
  const next = { ...lease, ...patch, lastUsedAt: now };
  store.write(next);
  return next;
}

export function releaseLease(store: LeaseStore, threadId: string): boolean {
  const lease = store.read();
  if (lease === null || lease.threadId !== threadId) return false;
  store.write(null);
  return true;
}

export function parseLease(payload: string): SauceLease | null {
  try {
    const value = JSON.parse(payload) as Partial<SauceLease>;
    if (typeof value.threadId !== "string" || typeof value.lastUsedAt !== "number") return null;
    return {
      threadId: value.threadId,
      acquiredAt: typeof value.acquiredAt === "number" ? value.acquiredAt : value.lastUsedAt,
      lastUsedAt: value.lastUsedAt,
      device: typeof value.device === "string" ? value.device : null,
      rotation: typeof value.rotation === "number" ? value.rotation : null,
    };
  } catch {
    return null;
  }
}
