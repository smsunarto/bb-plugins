import { mock, test } from "bun:test";
import assert from "node:assert/strict";

import {
  mountNotificationRenderer,
  type RendererDependencies,
} from "./notification-renderer.ts";

test("an open BB renderer shows, acknowledges, and opens one notification", async () => {
  const controller = new AbortController();
  const notifications: Array<{
    title: string;
    options: NotificationOptions | undefined;
    click: (() => void) | null;
    closed: boolean;
  }> = [];

  class FakeNotification {
    static permission: NotificationPermission = "granted";

    static async requestPermission(): Promise<NotificationPermission> {
      return FakeNotification.permission;
    }

    readonly record: (typeof notifications)[number];

    constructor(title: string, options?: NotificationOptions) {
      this.record = { title, options, click: null, closed: false };
      notifications.push(this.record);
    }

    addEventListener(type: "click", listener: () => void): void {
      if (type === "click") this.record.click = listener;
    }

    close(): void {
      this.record.closed = true;
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
  };

  await mountNotificationRenderer({ signal: controller.signal, dependencies });

  assert.deepEqual(notifications.map(({ title, options }) => ({ title, options })), [
    {
      title: "Build",
      options: {
        body: "finished",
        silent: true,
        tag: "bb-notify-delivery-1",
      },
    },
  ]);
  notifications[0]?.click?.();
  await Promise.resolve();
  assert.equal(focus.mock.calls.length, 1);
  assert.ok(fetch.mock.calls.some(([input]) => String(input).endsWith("/open")));
  assert.equal(notifications[0]?.closed, true);
});

test("a browser tab never starts the renderer mailbox", async () => {
  const fetch = mock<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  await mountNotificationRenderer({
    signal: new AbortController().signal,
    dependencies: {
      fetch,
      Notification: undefined,
      locks: undefined,
      desktopBridge: undefined,
      focus() {},
    },
  });
  assert.equal(fetch.mock.calls.length, 0);
});
