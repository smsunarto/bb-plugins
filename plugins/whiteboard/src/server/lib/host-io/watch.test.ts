import { expect, test, vi } from "vitest";
import { installHostClient, type WhiteboardHostClient } from "./client.ts";
import { inProcessResolver } from "./testing/in-process.ts";
import { WATCH_CHECK_MS, checkWatches, watch } from "./watch.ts";

test("the first successful arm invalidates any inspection made before the host began watching", async () => {
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const callbacks = new Set<() => void>();
  const client = {
    call: async (method: string) => {
      calls.push(method);
      if (method === "watchWorktree")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { ok: true };
    },
    experimental_onSignal: () => () => {},
    experimental_onWorkerExit: (callback: () => void) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  } as unknown as WhiteboardHostClient;
  const uninstall = installHostClient(client, inProcessResolver());
  const notices: string[] = [];
  const watcher = watch("/checkout", undefined, (event) => {
    notices.push(event);
  });
  try {
    await expect.poll(() => calls).toEqual(["watchWorktree"]);
    // A source inspection has already completed and a file changed while arming is suspended.
    expect(notices).toEqual([]);
    release!();
    await expect.poll(() => notices).toEqual(["rename"]);
    watcher.close();
    expect(calls).toEqual(["watchWorktree", "unwatchWorktree"]);
  } finally {
    watcher.close();
    uninstall();
    expect(callbacks.size).toBe(0);
  }
});

test("a check re-arms a watch its host no longer holds and leaves held watches alone", async () => {
  const calls: Array<{ method: string; input: { watchId?: string; watchIds?: string[] } }> = [];
  let restarted = false;
  const client = {
    call: async (method: string, input: { watchId?: string; watchIds?: string[] }) => {
      calls.push({ method, input });
      // A restarted daemon's fresh worker holds no watch.
      if (method === "watchAlive") return { live: restarted ? [] : input.watchIds };
      return { ok: true };
    },
    experimental_onSignal: () => () => {},
    experimental_onWorkerExit: () => () => {},
  } as unknown as WhiteboardHostClient;
  const uninstall = installHostClient(client, inProcessResolver());
  const notices: string[] = [];
  const watcher = watch("/checkout", undefined, (event) => {
    notices.push(event);
  });
  try {
    await expect.poll(() => notices).toEqual(["rename"]);
    await checkWatches();
    expect(calls.map((call) => call.method)).toEqual(["watchWorktree", "watchAlive"]);
    expect(notices).toEqual(["rename"]);
    restarted = true;
    await checkWatches();
    await expect
      .poll(() => calls.map((call) => call.method))
      .toEqual(["watchWorktree", "watchAlive", "watchAlive", "watchWorktree"]);
    // Changes made while nothing watched are unknown: the cache is invalidated once more.
    expect(notices).toEqual(["rename", "rename"]);
    const [first, again] = calls.filter((call) => call.method === "watchWorktree");
    expect(again!.input).toEqual(first!.input);
  } finally {
    watcher.close();
    uninstall();
  }
});

test("armed watches are checked every interval, with or without a panel, until the last one closes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const methods: string[] = [];
  const client = {
    call: async (method: string, input: { watchIds?: string[] }) => {
      methods.push(method);
      return method === "watchAlive" ? { live: input.watchIds } : { ok: true };
    },
    experimental_onSignal: () => () => {},
    experimental_onWorkerExit: () => () => {},
  } as unknown as WhiteboardHostClient;
  const uninstall = installHostClient(client, inProcessResolver());
  const notices: string[] = [];
  const watcher = watch("/checkout", undefined, (event) => {
    notices.push(event);
  });
  try {
    await expect.poll(() => notices).toEqual(["rename"]);
    await vi.advanceTimersByTimeAsync(WATCH_CHECK_MS);
    expect(methods).toEqual(["watchWorktree", "watchAlive"]);
    watcher.close();
    await vi.advanceTimersByTimeAsync(WATCH_CHECK_MS * 3);
    // A closed watch costs its host nothing more.
    expect(methods).toEqual(["watchWorktree", "watchAlive", "unwatchWorktree"]);
  } finally {
    vi.useRealTimers();
    watcher.close();
    uninstall();
  }
});
