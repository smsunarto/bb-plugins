import { randomUUID } from "node:crypto";

const STATE_KEY = "notification-queue-v1";
const STATE_VERSION = 1;

export const DELIVERY_LEASE_MS = 30_000;
export const QUEUE_MAX = 20;
export const QUEUE_STALE_MS = 10 * 60_000;

export interface NotificationInput {
  title: string;
  body: string;
  threadId: string | null;
  silent: boolean;
  /** System sound played on the server after the renderer acknowledges display. */
  play: string | null;
}

export interface PendingNotification {
  id: number;
  title: string;
  body: string;
  threadId: string | null;
  silent: boolean;
}

export interface NotificationLease {
  id: string;
  notifications: PendingNotification[];
}

export interface LeaseResult {
  lease: NotificationLease | null;
  /** When an existing lease is the only thing preventing delivery. */
  retryAfterMs: number | null;
}

export interface AcknowledgementResult {
  acknowledged: number;
  /** One tone for the acknowledged batch; batching avoids overlapping sounds. */
  play: string | null;
}

export interface NotificationQueueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface StoredLease {
  id: string;
  expiresAt: number;
}

interface StoredNotification extends NotificationInput {
  id: number;
  queuedAt: number;
  lease: StoredLease | null;
}

interface StoredState {
  version: typeof STATE_VERSION;
  nextId: number;
  items: StoredNotification[];
}

interface LoadedState {
  state: StoredState;
  changed: boolean;
}

function emptyState(): StoredState {
  return { version: STATE_VERSION, nextId: 0, items: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLease(value: unknown): StoredLease | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  ) {
    return undefined;
  }
  return { id: value.id, expiresAt: value.expiresAt };
}

function parseItem(value: unknown): StoredNotification | null {
  if (!isRecord(value)) return null;
  const lease = parseLease(value.lease);
  if (
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    (value.threadId !== null && typeof value.threadId !== "string") ||
    typeof value.silent !== "boolean" ||
    (value.play !== null && typeof value.play !== "string") ||
    typeof value.queuedAt !== "number" ||
    !Number.isFinite(value.queuedAt) ||
    lease === undefined
  ) {
    return null;
  }
  return {
    id: value.id as number,
    title: value.title,
    body: value.body,
    threadId: value.threadId as string | null,
    silent: value.silent,
    play: value.play as string | null,
    queuedAt: value.queuedAt,
    lease,
  };
}

function loadState(value: unknown, now: number): LoadedState {
  if (
    !isRecord(value) ||
    value.version !== STATE_VERSION ||
    !Number.isSafeInteger(value.nextId) ||
    (value.nextId as number) < 0 ||
    !Array.isArray(value.items)
  ) {
    return { state: emptyState(), changed: value !== undefined };
  }

  let changed = false;
  const cutoff = now - QUEUE_STALE_MS;
  const items: StoredNotification[] = [];
  const seenIds = new Set<number>();
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (item === null || item.queuedAt < cutoff || seenIds.has(item.id)) {
      changed = true;
      continue;
    }
    seenIds.add(item.id);
    if (item.lease !== null && item.lease.expiresAt <= now) {
      item.lease = null;
      changed = true;
    }
    items.push(item);
  }
  if (items.length > QUEUE_MAX) {
    items.splice(0, items.length - QUEUE_MAX);
    changed = true;
  }

  const highestId = items.reduce((highest, item) => Math.max(highest, item.id), 0);
  const storedNextId = value.nextId as number;
  const nextId = Math.max(storedNextId, highestId);
  if (nextId !== storedNextId) changed = true;
  return {
    state: { version: STATE_VERSION, nextId, items },
    changed,
  };
}

function publicNotification(item: StoredNotification): PendingNotification {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    threadId: item.threadId,
    silent: item.silent,
  };
}

/**
 * Durable at-least-once delivery for the renderer bridge.
 *
 * Every mutation reloads the stored state first. That matters during plugin
 * reload: BB builds the replacement generation while the old one may still be
 * handling a request, so a state snapshot captured by the candidate factory
 * could otherwise miss the old generation's final write.
 */
export class NotificationQueue {
  private serial: Promise<void> = Promise.resolve();
  private readonly store: NotificationQueueStore;
  private readonly now: () => number;
  private readonly createLeaseId: () => string;

  constructor(
    store: NotificationQueueStore,
    now: () => number = Date.now,
    createLeaseId: () => string = randomUUID,
  ) {
    this.store = store;
    this.now = now;
    this.createLeaseId = createLeaseId;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<LoadedState> {
    return loadState(await this.store.get<unknown>(STATE_KEY), this.now());
  }

  private async saveIfChanged(loaded: LoadedState): Promise<void> {
    if (loaded.changed) await this.store.set(STATE_KEY, loaded.state);
  }

  enqueue(input: NotificationInput): Promise<number> {
    return this.run(async () => {
      const loaded = await this.read();
      const { state } = loaded;
      state.nextId += 1;
      state.items.push({
        ...input,
        id: state.nextId,
        queuedAt: this.now(),
        lease: null,
      });
      if (state.items.length > QUEUE_MAX) state.items.shift();
      loaded.changed = true;
      await this.saveIfChanged(loaded);
      return state.nextId;
    });
  }

  lease(): Promise<LeaseResult> {
    return this.run(async () => {
      const loaded = await this.read();
      const { state } = loaded;
      const available = state.items.filter((item) => item.lease === null);
      if (available.length === 0) {
        await this.saveIfChanged(loaded);
        const nextExpiry = state.items.reduce<number | null>((nearest, item) => {
          if (item.lease === null) return nearest;
          return nearest === null
            ? item.lease.expiresAt
            : Math.min(nearest, item.lease.expiresAt);
        }, null);
        return {
          lease: null,
          retryAfterMs:
            nextExpiry === null ? null : Math.max(0, nextExpiry - this.now()),
        };
      }

      const leaseId = this.createLeaseId();
      const expiresAt = this.now() + DELIVERY_LEASE_MS;
      for (const item of available) item.lease = { id: leaseId, expiresAt };
      loaded.changed = true;
      await this.saveIfChanged(loaded);
      return {
        lease: {
          id: leaseId,
          notifications: available.map(publicNotification),
        },
        retryAfterMs: null,
      };
    });
  }

  acknowledge(leaseId: string, notificationIds: readonly number[]): Promise<AcknowledgementResult> {
    return this.run(async () => {
      const loaded = await this.read();
      const acknowledgedIds = new Set(notificationIds);
      let acknowledged = 0;
      let play: string | null = null;
      loaded.state.items = loaded.state.items.filter((item) => {
        if (item.lease?.id !== leaseId || !acknowledgedIds.has(item.id)) return true;
        acknowledged += 1;
        play ??= item.play;
        return false;
      });
      if (acknowledged > 0) loaded.changed = true;
      await this.saveIfChanged(loaded);
      return { acknowledged, play };
    });
  }

  count(): Promise<number> {
    return this.run(async () => {
      const loaded = await this.read();
      await this.saveIfChanged(loaded);
      return loaded.state.items.length;
    });
  }
}
