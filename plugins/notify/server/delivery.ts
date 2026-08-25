import type { Context } from "@bb-kit/core/plugin";
import { BODY_MAX_CHARS, notificationLines, oneLine } from "./format.ts";
import {
  NotificationQueue,
  type AcknowledgementResult,
  type NotificationInput,
  type NotificationQueueStore,
  type PendingNotification,
} from "./queue.ts";
import { pluginSettings } from "./settings.ts";
import { resolveSound } from "./sound.ts";

/** How long a long-poll is held open before returning an empty batch. */
export const POLL_HOLD_MS = 25_000;
/** A window that polled this recently still counts as able to display. */
export const RENDERER_TTL_MS = 40_000;

export type Batch = {
  leaseId: string | null;
  notifications: PendingNotification[];
};

export type DeliverySnapshot = {
  listening: boolean;
  polling: number;
  held: number;
};

/**
 * Durable queue plus the in-memory waiters a `/pending` long-poll holds.
 * Interned by the host so send, status, and routes share waiters
 * without putting them on Context.
 */
export type Delivery = {
  readonly queue: NotificationQueue;
  enqueue(input: NotificationInput): Promise<boolean>;
  nextBatch(signal: AbortSignal): Promise<Batch>;
  acknowledge(leaseId: string, notificationIds: readonly number[]): Promise<AcknowledgementResult>;
  snapshot(): Promise<DeliverySnapshot>;
  markPoll(): void;
  isListening(): boolean;
  pollingCount(): number;
  waitForQueue(signal: AbortSignal, holdMs: number): Promise<void>;
  release(): void;
};

const deliveries = new WeakMap<object, Delivery>();

function kvStore(bb: object): NotificationQueueStore {
  const kv = (bb as { storage?: { kv?: NotificationQueueStore } }).storage?.kv;
  if (kv === undefined) {
    throw new Error("plugin storage has no kv");
  }
  return kv;
}

export function notificationQueue(bb: object): Delivery {
  const existing = deliveries.get(bb);
  if (existing) return existing;
  const created = createDelivery(kvStore(bb));
  deliveries.set(bb, created);
  return created;
}

function createDelivery(store: NotificationQueueStore): Delivery {
  const queue = new NotificationQueue(store);
  const waiters = new Set<() => void>();
  let lastPollAt = 0;

  function isListening(): boolean {
    return waiters.size > 0 || Date.now() - lastPollAt < RENDERER_TTL_MS;
  }

  function wakeWaiters(): void {
    for (const wake of waiters) wake();
  }

  function waitForQueue(signal: AbortSignal, holdMs: number): Promise<void> {
    if (signal.aborted || holdMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const settle = () => {
        waiters.delete(settle);
        clearTimeout(timer);
        signal.removeEventListener("abort", settle);
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve();
      };
      const timer = setTimeout(settle, holdMs);
      signal.addEventListener("abort", settle, { once: true });
      waiters.add(settle);
    });
  }

  const delivery: Delivery = {
    queue,
    async enqueue(input) {
      await queue.enqueue(input);
      const listening = isListening();
      wakeWaiters();
      return listening;
    },
    async nextBatch(signal) {
      delivery.markPoll();
      let result = await queue.lease();
      if (result.lease === null) {
        const holdMs = Math.min(POLL_HOLD_MS, result.retryAfterMs ?? POLL_HOLD_MS);
        await waitForQueue(signal, holdMs);
        if (signal.aborted) {
          return { leaseId: null, notifications: [] };
        }
        result = await queue.lease();
      }
      delivery.markPoll();
      return {
        leaseId: result.lease?.id ?? null,
        notifications: result.lease?.notifications ?? [],
      };
    },
    acknowledge(leaseId, notificationIds) {
      return queue.acknowledge(leaseId, notificationIds);
    },
    async snapshot() {
      return {
        listening: isListening(),
        polling: waiters.size,
        held: await queue.count(),
      };
    },
    markPoll() {
      lastPollAt = Date.now();
    },
    isListening,
    pollingCount: () => waiters.size,
    waitForQueue,
    release: wakeWaiters,
  };
  return delivery;
}

export type PostInput = {
  project: string | null;
  heading: string;
  message: string;
  threadId: string | null;
};

export async function deliver(bb: Context["bb"], input: PostInput): Promise<boolean> {
  const settings = pluginSettings(bb);
  const { silent, play } = resolveSound(settings.sound);
  const { title, body } = notificationLines(input.project, oneLine(input.heading, 90), input.message);
  const delivery = notificationQueue(bb);
  const listening = await delivery.enqueue({
    title: oneLine(title, 90),
    body: oneLine(body, BODY_MAX_CHARS),
    threadId: input.threadId,
    silent,
    play,
  });
  bb.log.debug(`${listening ? "queued" : "held"} — opens ${input.threadId ?? "nothing"}`);
  return listening;
}
