import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DELIVERY_LEASE_MS,
  NotificationQueue,
  QUEUE_MAX,
  QUEUE_STALE_MS,
  type NotificationInput,
  type NotificationQueueStore,
} from "../queue.ts";

class MemoryStore implements NotificationQueueStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

function notification(message: string, play: string | null = null): NotificationInput {
  return {
    title: "Thread",
    body: message,
    threadId: "thread-1",
    silent: play !== null,
    play,
  };
}

test("a lease retains notifications until the renderer acknowledges them", async () => {
  const store = new MemoryStore();
  const queue = new NotificationQueue(store, () => 1_000, () => "lease-1");
  const id = await queue.enqueue(notification("Done"));

  const delivery = await queue.lease();
  assert.deepEqual(delivery.lease, {
    id: "lease-1",
    notifications: [
      {
        id,
        title: "Thread",
        body: "Done",
        threadId: "thread-1",
        silent: false,
      },
    ],
  });
  assert.equal(await queue.count(), 1);

  const acknowledged = await queue.acknowledge("lease-1", [id]);
  assert.deepEqual(acknowledged, { acknowledged: 1, play: null });
  assert.equal(await queue.count(), 0);
});

test("an unacknowledged lease is redelivered after it expires", async () => {
  let now = 5_000;
  let leaseSequence = 0;
  const store = new MemoryStore();
  const queue = new NotificationQueue(
    store,
    () => now,
    () => `lease-${++leaseSequence}`,
  );
  const id = await queue.enqueue(notification("Retry me"));
  assert.equal((await queue.lease()).lease?.id, "lease-1");

  const blocked = await queue.lease();
  assert.equal(blocked.lease, null);
  assert.equal(blocked.retryAfterMs, DELIVERY_LEASE_MS);

  now += DELIVERY_LEASE_MS + 1;
  const retried = await queue.lease();
  assert.equal(retried.lease?.id, "lease-2");
  assert.deepEqual(retried.lease?.notifications.map((item) => item.id), [id]);
});

test("acknowledgement removes only displayed ids and returns one batch tone", async () => {
  let now = 10_000;
  const store = new MemoryStore();
  const queue = new NotificationQueue(store, () => now, () => "lease-a");
  const first = await queue.enqueue(notification("First", "Ping"));
  const second = await queue.enqueue(notification("Second", "Glass"));
  await queue.lease();

  assert.deepEqual(await queue.acknowledge("lease-a", [first]), {
    acknowledged: 1,
    play: "Ping",
  });
  assert.equal(await queue.count(), 1);

  now += DELIVERY_LEASE_MS + 1;
  const remaining = await queue.lease();
  assert.deepEqual(remaining.lease?.notifications.map((item) => item.id), [second]);
});

test("persisted notifications survive a queue instance replacement", async () => {
  const store = new MemoryStore();
  const beforeReload = new NotificationQueue(store, () => 1_000, () => "old");
  const id = await beforeReload.enqueue(notification("Held"));

  const afterReload = new NotificationQueue(store, () => 1_000, () => "new");
  const delivery = await afterReload.lease();
  assert.deepEqual(delivery.lease?.notifications.map((item) => item.id), [id]);
});

test("concurrent pollers cannot lease the same notification", async () => {
  const store = new MemoryStore();
  const queue = new NotificationQueue(store, () => 1_000, () => "only-lease");
  await queue.enqueue(notification("Once"));

  const deliveries = await Promise.all([queue.lease(), queue.lease()]);
  assert.equal(deliveries.filter((delivery) => delivery.lease !== null).length, 1);
});

test("the durable queue stays bounded and expires old news", async () => {
  let now = 1_000;
  const store = new MemoryStore();
  const queue = new NotificationQueue(store, () => now, () => "lease");
  for (let index = 0; index <= QUEUE_MAX; index += 1) {
    await queue.enqueue(notification(`Item ${index}`));
  }

  const delivery = await queue.lease();
  assert.equal(delivery.lease?.notifications.length, QUEUE_MAX);
  assert.equal(delivery.lease?.notifications[0]?.body, "Item 1");

  now += QUEUE_STALE_MS + 1;
  assert.equal(await queue.count(), 0);
});
