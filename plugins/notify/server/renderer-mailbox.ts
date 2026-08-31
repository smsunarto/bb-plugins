import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  openThreadSchema,
  rendererAckSchema,
  rendererHttpPaths,
  type DeliveryEnvelope,
  type RendererAck,
  type RendererNotification,
} from "../shared/renderer-http.ts";

export type NotificationOffer = RendererNotification &
  Readonly<{
    play: string | null;
  }>;

export type OfferResult = "shown" | "suppressed" | "unavailable" | "failed";

export type AcknowledgementResult = Readonly<{
  accepted: boolean;
  play: string | null;
}>;

export type RendererMailbox = Readonly<{
  offer(notification: NotificationOffer): Promise<OfferResult>;
  wait(signal: AbortSignal): Promise<DeliveryEnvelope | null>;
  acknowledge(ack: RendererAck): AcknowledgementResult;
  dispose(): void;
}>;

type Waiter = {
  resolve: (envelope: DeliveryEnvelope | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
};

type PendingOffer = {
  notification: NotificationOffer;
  resolve: (result: OfferResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type InFlightOffer = {
  resolve: (result: OfferResult) => void;
  play: string | null;
  timer: ReturnType<typeof setTimeout>;
};

export function createRendererMailbox(
  options: {
    ackTimeoutMs?: number;
    handoffWindowMs?: number;
    handoffCapacity?: number;
    longPollMs?: number;
    createId?: () => string;
    now?: () => number;
  } = {},
): RendererMailbox {
  const ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
  const handoffWindowMs = options.handoffWindowMs ?? 500;
  const handoffCapacity = options.handoffCapacity ?? 8;
  const longPollMs = options.longPollMs ?? 25_000;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const waiters: Waiter[] = [];
  const pending: PendingOffer[] = [];
  const inFlight = new Map<string, InFlightOffer>();
  let handoffUntil = 0;
  let disposed = false;

  function removeWaiter(waiter: Waiter): boolean {
    const index = waiters.indexOf(waiter);
    if (index === -1) return false;
    waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    return true;
  }

  function finishWaiter(waiter: Waiter, envelope: DeliveryEnvelope | null): void {
    if (!removeWaiter(waiter)) return;
    waiter.resolve(envelope);
  }

  function finishInFlight(id: string, result: OfferResult): InFlightOffer | null {
    const record = inFlight.get(id);
    if (record === undefined) return null;
    inFlight.delete(id);
    clearTimeout(record.timer);
    record.resolve(result);
    return record;
  }

  function handOff(waiter: Waiter, queued: PendingOffer): void {
    if (queued.timer !== null) clearTimeout(queued.timer);
    const id = createId();
    handoffUntil = now() + handoffWindowMs;
    const notification: RendererNotification = {
      title: queued.notification.title,
      body: queued.notification.body,
      threadId: queued.notification.threadId,
      silent: queued.notification.silent,
    };
    const timer = setTimeout(() => {
      finishInFlight(id, "failed");
    }, ackTimeoutMs);
    inFlight.set(id, {
      resolve: queued.resolve,
      play: queued.notification.play,
      timer,
    });
    finishWaiter(waiter, { id, notification });
  }

  function drain(): void {
    while (waiters.length > 0 && pending.length > 0) {
      const waiter = waiters[0]!;
      const queued = pending.shift()!;
      handOff(waiter, queued);
    }
  }

  function buffer(notification: NotificationOffer): Promise<OfferResult> {
    const remaining = handoffUntil - now();
    if (remaining <= 0 || pending.length >= handoffCapacity) {
      return Promise.resolve("unavailable");
    }
    return new Promise((resolve) => {
      const queued = {
        notification,
        resolve,
        timer: setTimeout(() => {
          const index = pending.indexOf(queued);
          if (index === -1) return;
          pending.splice(index, 1);
          resolve("unavailable");
        }, remaining),
      } satisfies PendingOffer;
      pending.push(queued);
    });
  }

  return {
    offer(notification) {
      if (disposed) return Promise.resolve("unavailable");
      const waiter = waiters[0];
      if (waiter === undefined) return buffer(notification);
      return new Promise((resolve) => {
        const queued = {
          notification,
          resolve,
          timer: null,
        } satisfies PendingOffer;
        handOff(waiter, queued);
      });
    },
    wait(signal) {
      if (disposed || signal.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        let waiter: Waiter;
        const onAbort = () => finishWaiter(waiter, null);
        waiter = {
          resolve,
          signal,
          onAbort,
          timer: setTimeout(() => finishWaiter(waiter, null), longPollMs),
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
        drain();
      });
    },
    acknowledge(ack) {
      const record = finishInFlight(ack.id, ack.outcome);
      return {
        accepted: record !== null,
        play: ack.outcome === "shown" ? (record?.play ?? null) : null,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      while (waiters[0] !== undefined) finishWaiter(waiters[0], null);
      for (const queued of pending.splice(0)) {
        if (queued.timer !== null) clearTimeout(queued.timer);
        queued.resolve("unavailable");
      }
      for (const id of inFlight.keys()) finishInFlight(id, "failed");
    },
  };
}

const mailboxes = new WeakMap<object, RendererMailbox>();

export function rendererMailbox(bb: object): RendererMailbox {
  const existing = mailboxes.get(bb);
  if (existing !== undefined) return existing;
  const created = createRendererMailbox();
  mailboxes.set(bb, created);
  return created;
}

export function registerRendererMailboxRoutes(
  bb: BbPluginApi,
  options: {
    mailbox?: RendererMailbox;
    queueSound?: (name: string) => void;
  } = {},
): void {
  const mailbox = options.mailbox ?? rendererMailbox(bb);
  const queueSound = options.queueSound ?? (() => {});

  bb.http.route("GET", rendererHttpPaths.next, async (c) => {
    const envelope = await mailbox.wait(c.req.raw.signal);
    if (envelope === null) return new Response(null, { status: 204 });
    return c.json(envelope);
  });

  bb.http.route("POST", rendererHttpPaths.acknowledge, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = rendererAckSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid acknowledgement" }, 400);
    }
    const result = mailbox.acknowledge(parsed.data);
    if (result.play !== null) queueSound(result.play);
    return new Response(null, { status: 204 });
  });

  bb.http.route("POST", rendererHttpPaths.openThread, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = openThreadSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: "invalid threadId" }, 400);
    try {
      await bb.sdk.threads.open({ threadId: parsed.data.threadId, file: null });
      return c.json({ ok: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      bb.log.warn(`open ${parsed.data.threadId} failed: ${detail}`);
      return c.json({ ok: false, error: detail }, 502);
    }
  });
}
