import { mock, type Mock } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { Context } from "@bb-kit/core/plugin";
import {
  bindNotificationSender,
  type NativeNotification,
  type NotificationSender,
} from "./delivery.ts";
import { bindSettings, fakeSettings, type Settings } from "./settings.ts";

export type FakeContextOptions = {
  available?: boolean;
  settings?: Partial<Settings>;
  projectName?: (projectId: string) => Promise<string | null>;
  thread?: { title: string | null; titleFallback: string | null; projectId: string };
};

const sendersByHost = new WeakMap<object, Mock<NotificationSender>>();

export function createFakeContext(options: FakeContextOptions = {}): Context {
  const settings = fakeSettings(options.settings);
  const sdk = {
    projects: {
      get: async ({ projectId }: { projectId: string }) => {
        const name =
          options.projectName === undefined ? null : await options.projectName(projectId);
        if (name === null) throw new Error("missing project");
        return { name };
      },
    },
    threads: {
      get: async () => {
        if (options.thread === undefined) throw new Error("missing thread");
        return options.thread;
      },
      events: {
        list: async () => [],
      },
    },
  };
  const bb = {
    sdk,
    log: {
      info() {},
      debug() {},
      warn() {},
    },
  };
  const ctx = stubHostContext({
    bb: bb as unknown as Context["bb"],
  });
  const sender = mock<NotificationSender>(async () => {
    if (options.available === false) {
      throw new Error("notification unavailable");
    }
  });
  sendersByHost.set(ctx.bb, sender);
  bindNotificationSender(ctx.bb, sender);
  bindSettings(ctx.bb, () => settings);
  return ctx;
}

export function shownNotifications(ctx: Context): NativeNotification[] {
  return sendersByHost.get(ctx.bb)?.mock.calls.map(([notification]) => notification) ?? [];
}
