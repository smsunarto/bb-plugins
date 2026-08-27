import { stubHostContext } from "@bb-kit/core/testing";
import type { Context } from "@bb-kit/core/plugin";
import { bindNotificationSender, type NativeNotification } from "./delivery.ts";
import { bindSettings, fakeSettings, type Settings } from "./settings.ts";

export type FakeContextOptions = {
  available?: boolean;
  settings?: Partial<Settings>;
  projectName?: (projectId: string) => Promise<string | null>;
  thread?: { title: string | null; titleFallback: string | null; projectId: string };
};

const callsByHost = new WeakMap<object, NativeNotification[]>();

export function createFakeContext(options: FakeContextOptions = {}): Context {
  const settings = fakeSettings(options.settings);
  const calls: NativeNotification[] = [];
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
  callsByHost.set(ctx.bb, calls);
  bindNotificationSender(ctx.bb, async (notification) => {
    calls.push(notification);
    if (options.available === false) {
      throw new Error("notification unavailable");
    }
  });
  bindSettings(ctx.bb, () => settings);
  return ctx;
}

export function shownNotifications(ctx: Context): NativeNotification[] {
  return callsByHost.get(ctx.bb) ?? [];
}
