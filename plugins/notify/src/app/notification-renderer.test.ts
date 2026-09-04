import { mock, test } from "bun:test";
import assert from "node:assert/strict";

import {
  mountNotificationRenderer,
  runNotificationRenderer,
  type RendererDependencies,
} from "./notification-renderer.ts";
import type { AttentionEventTarget, AttentionSource } from "./thread-attention.ts";

class FakeEvents implements AttentionEventTarget {
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function attentionSource(
  pathname = "/settings",
  focused = true,
): AttentionSource & {
  state: { pathname: string; focused: boolean };
  windowEvents: FakeEvents;
} {
  const state = { pathname, focused };
  return {
    state,
    windowEvents: new FakeEvents(),
    documentEvents: new FakeEvents(),
    pathname: () => state.pathname,
    visibilityState: () => "visible",
    hasFocus: () => state.focused,
  };
}

function attentionDependencies(source = attentionSource()) {
  return {
    attentionSource: source,
    createAttentionChannel: () => null,
  };
}

test("an open BB renderer shows, acknowledges, and opens one notification", async () => {
  const controller = new AbortController();
  const notifications: Array<{
    title: string;
    options: NotificationOptions | undefined;
    click: (() => void) | null;
    closeListeners: Set<() => void>;
    closed: boolean;
  }> = [];

  class FakeNotification {
    static permission: NotificationPermission = "granted";

    static async requestPermission(): Promise<NotificationPermission> {
      return FakeNotification.permission;
    }

    readonly record: (typeof notifications)[number];

    constructor(title: string, options?: NotificationOptions) {
      this.record = { title, options, click: null, closeListeners: new Set(), closed: false };
      notifications.push(this.record);
    }

    addEventListener(type: "click" | "close", listener: () => void): void {
      if (type === "click") this.record.click = listener;
      else this.record.closeListeners.add(listener);
    }

    close(): void {
      this.record.closed = true;
      for (const listener of this.record.closeListeners) listener();
    }
  }

  let nextCount = 0;
  const fetch = mock<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/mailbox/next")) {
      nextCount += 1;
      if (nextCount === 1) {
        return Response.json({
          id: "delivery-1",
          notification: {
            title: "Build",
            body: "finished",
            threadId: "th_1",
            silent: true,
          },
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/mailbox/ack")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        id: "delivery-1",
        outcome: "shown",
      });
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/open")) return Response.json({ ok: true });
    throw new Error(`unexpected URL: ${url}`);
  });
  const focus = mock(() => {});
  const dependencies: RendererDependencies = {
    fetch,
    Notification: FakeNotification as unknown as RendererDependencies["Notification"],
    locks: {
      request: async (_name, _options, callback) => callback(),
    },
    desktopBridge: {},
    focus,
    ...attentionDependencies(),
  };

  await runNotificationRenderer({ pluginId: "notify", signal: controller.signal, dependencies });

  assert.deepEqual(
    notifications.map(({ title, options }) => ({ title, options })),
    [
      {
        title: "Build",
        options: {
          body: "finished",
          silent: true,
          tag: "bb-notify-delivery-1",
        },
      },
    ],
  );
  notifications[0]?.click?.();
  await Promise.resolve();
  assert.equal(focus.mock.calls.length, 1);
  assert.ok(fetch.mock.calls.some(([input]) => String(input).endsWith("/open")));
  assert.equal(notifications[0]?.closed, true);
});

test("a browser tab never starts the renderer mailbox", async () => {
  const fetch = mock<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  await runNotificationRenderer({
    pluginId: "notify",
    signal: new AbortController().signal,
    dependencies: {
      fetch,
      Notification: undefined,
      locks: undefined,
      desktopBridge: undefined,
      focus() {},
      ...attentionDependencies(),
    },
  });
  assert.equal(fetch.mock.calls.length, 0);
});

test("an active visible focused target acknowledges suppressed without constructing Notification", async () => {
  const controller = new AbortController();
  let constructed = 0;
  let nextCount = 0;
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static async requestPermission(): Promise<NotificationPermission> {
      return "granted";
    }
    constructor() {
      constructed += 1;
    }
    addEventListener(): void {}
    close(): void {}
  }
  const fetch = mock<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/mailbox/next")) {
      nextCount += 1;
      if (nextCount === 1) {
        return Response.json({
          id: "delivery-suppressed",
          notification: {
            title: "Build",
            body: "finished",
            threadId: "thr_active",
            silent: true,
          },
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/mailbox/ack")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        id: "delivery-suppressed",
        outcome: "suppressed",
      });
      controller.abort();
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  await runNotificationRenderer({
    pluginId: "notify",
    signal: controller.signal,
    dependencies: {
      fetch,
      Notification: FakeNotification as unknown as RendererDependencies["Notification"],
      locks: { request: async (_name, _options, callback) => callback() },
      desktopBridge: {},
      focus() {},
      ...attentionDependencies(attentionSource("/threads/thr_active")),
    },
  });

  assert.equal(constructed, 0);
});

test("the target in an unfocused window shows then closes when that window gains focus", async () => {
  const controller = new AbortController();
  const source = attentionSource("/threads/thr_active", false);
  const records: Array<{ closed: boolean; closeListeners: Set<() => void> }> = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static async requestPermission(): Promise<NotificationPermission> {
      return "granted";
    }
    readonly record = { closed: false, closeListeners: new Set<() => void>() };
    constructor() {
      records.push(this.record);
    }
    addEventListener(type: "click" | "close", listener: () => void): void {
      if (type === "close") this.record.closeListeners.add(listener);
    }
    close(): void {
      if (this.record.closed) return;
      this.record.closed = true;
      for (const listener of this.record.closeListeners) listener();
    }
  }
  let nextCount = 0;
  let acknowledge = () => {};
  const acknowledged = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const fetch = mock<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/mailbox/next")) {
      nextCount += 1;
      if (nextCount === 1) {
        return Response.json({
          id: "delivery-background",
          notification: {
            title: "Build",
            body: "finished",
            threadId: "thr_active",
            silent: true,
          },
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/mailbox/ack")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        id: "delivery-background",
        outcome: "shown",
      });
      acknowledge();
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const mounted = runNotificationRenderer({
    pluginId: "notify",
    signal: controller.signal,
    dependencies: {
      fetch,
      Notification: FakeNotification as unknown as RendererDependencies["Notification"],
      locks: { request: async (_name, _options, callback) => callback() },
      desktopBridge: {},
      focus() {},
      ...attentionDependencies(source),
    },
  });
  await acknowledged;

  assert.equal(records.length, 1);
  assert.equal(records[0]?.closed, false);
  source.state.focused = true;
  source.windowEvents.dispatch("focus");
  assert.equal(records[0]?.closed, true);
  controller.abort();
  await mounted;
});

test("mount returns before the poller stops so bb's mount timeout never aborts it", async () => {
  const controller = new AbortController();
  let polling = false;
  const fetch = mock<typeof globalThis.fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        polling = true;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static async requestPermission(): Promise<NotificationPermission> {
      return "granted";
    }
    addEventListener(): void {}
    close(): void {}
  }

  const result = mountNotificationRenderer({
    pluginId: "notify",
    signal: controller.signal,
    dependencies: {
      fetch,
      Notification: FakeNotification as unknown as RendererDependencies["Notification"],
      locks: { request: async (_name, _options, callback) => callback() },
      desktopBridge: {},
      focus() {},
      ...attentionDependencies(),
    },
  });

  assert.equal(result, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(polling, true);
  controller.abort();
});
