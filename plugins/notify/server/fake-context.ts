import { mock, type Mock } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { Context } from "@bb-kit/core/plugin";
import {
  bindNotificationOfferer,
  type NotificationOfferer,
} from "./delivery.ts";
import type { NotificationOffer } from "./renderer-mailbox.ts";
import { bindSettings, fakeSettings, type Settings } from "./settings.ts";

export type FakeContextOptions = {
  available?: boolean;
  settings?: Partial<Settings>;
  projectName?: (projectId: string) => Promise<string | null>;
  thread?: { title: string | null; titleFallback: string | null; projectId: string };
};

const offersByHost = new WeakMap<object, Mock<NotificationOfferer>>();

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
  const offer = mock<NotificationOfferer>(async () =>
    options.available === false ? "unavailable" : "shown",
  );
  offersByHost.set(ctx.bb, offer);
  bindNotificationOfferer(ctx.bb, offer);
  bindSettings(ctx.bb, () => settings);
  return ctx;
}

export function shownNotifications(ctx: Context): NotificationOffer[] {
  return offersByHost.get(ctx.bb)?.mock.calls.map(([notification]) => notification) ?? [];
}
