// An all-green fake Context for unit tests. Every method succeeds and stays
// inert; `posts` records what `post` was asked to deliver. Override any field
// through the `overrides` parameter to steer one behavior per test.
import type { Context, Settings } from "./context.ts";
import { NotificationQueue, type NotificationQueueStore } from "./queue.ts";

export interface FakeContext extends Context {
  /** Every notification handed to `post`, in order. */
  readonly posts: readonly {
    project: string | null;
    threadName: string;
    message: string;
    threadId: string | null;
  }[];
}

/** The default settings the fake reports; override per field as needed. */
export function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    notifyOnIdle: true,
    notifyOnFailed: true,
    includeChildThreads: false,
    includeHiddenThreads: false,
    minRunSeconds: "0",
    sound: "off",
    agentTool: false,
    ...overrides,
  };
}

function memoryStore(): NotificationQueueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    set: (key: string, value: unknown) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

export function createFakeContext(overrides: Partial<Context> = {}): FakeContext {
  const posts: {
    project: string | null;
    threadName: string;
    message: string;
    threadId: string | null;
  }[] = [];
  const settings = fakeSettings();
  return {
    posts,
    settings: () => settings,
    notifications: new NotificationQueue(memoryStore()),
    windowIsListening: () => true,
    pollingCount: () => 1,
    markPoll: () => {},
    waitForQueue: () => Promise.resolve(),
    queueSound: () => {},
    post: (project, threadName, message, threadId) => {
      posts.push({ project, threadName, message, threadId });
      return Promise.resolve(true);
    },
    projectName: () => Promise.resolve(null),
    rememberStart: () => {},
    clearStart: () => {},
    forget: () => {},
    notifyThread: () => Promise.resolve(),
    ...overrides,
  };
}
