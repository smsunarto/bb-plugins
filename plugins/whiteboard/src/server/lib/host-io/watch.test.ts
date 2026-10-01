import { expect, test } from "vitest";
import { installHostClient, type WhiteboardHostClient } from "./client.ts";
import { inProcessResolver } from "./testing/in-process.ts";
import { watch } from "./watch.ts";

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
