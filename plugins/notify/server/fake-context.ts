import { stubHostContext } from "@bb-kit/core/testing";
import type { Context } from "@bb-kit/core/plugin";
import { notificationQueue } from "./delivery.ts";
import { bindSettings, fakeSettings, type Settings } from "./settings.ts";

export { fakeSettings };

export type FakeContextOptions = {
  listening?: boolean;
  settings?: Partial<Settings>;
  projectName?: (projectId: string) => Promise<string | null>;
  thread?: { title: string | null; titleFallback: string | null; projectId: string };
};

export function createFakeContext(options: FakeContextOptions = {}): Context {
  const settings = fakeSettings(options.settings);
  const storage = { kv: memoryKv() };
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
    storage,
  };
  const context = stubHostContext({
    bb: bb as unknown as Context["bb"],
  });
  if (options.listening !== false) {
    notificationQueue(context.bb).markPoll();
  }
  bindSettings(context.bb, () => settings);
  return context;
}

export async function queuedNotifications(context: Context) {
  const batch = await notificationQueue(context.bb).queue.lease();
  return batch.lease?.notifications ?? [];
}

function memoryKv() {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | undefined> => map.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix?: string) =>
      [...map.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)),
  };
}
