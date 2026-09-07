import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, it, jest, mock } from "bun:test";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

if (process.env.GTD_LIFECYCLE_HOOK_TEST_CHILD !== "1") {
  it("lifecycle channel list passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_LIFECYCLE_HOOK_TEST_CHILD: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (
      html: string,
      options: { url: string },
    ) => {
      window: Window & typeof globalThis;
    };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (name in globalThis) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: Reflect.get(dom.window, name),
      writable: true,
    });
  }
  const { act, cleanup, configure } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createElement, useCallback, useState } = await import("react");
  const { useLifecycleChannelList } = await import("../hooks/use-lifecycle-channel-list.ts");

  interface ListProps {
    load: () => Promise<string>;
    apply: (value: string) => void;
  }

  function List({ load, apply }: ListProps) {
    const [value, setValue] = useState("visible rows");
    const ready = useLifecycleChannelList(
      load,
      useCallback(
        (next) => {
          apply(next);
          setValue(next);
        },
        [apply],
      ),
    );
    return createElement("output", { "data-ready": String(ready) }, value);
  }

  function ListPair({ first, second }: { first: ListProps; second: ListProps }) {
    return createElement("div", null, createElement(List, first), createElement(List, second));
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function pendingList() {
    const requests: ReturnType<typeof deferred<string>>[] = [];
    const load = mock(() => {
      const request = deferred<string>();
      requests.push(request);
      return request.promise;
    });
    const apply = mock<(value: string) => void>(() => {});
    return { requests, load, apply };
  }

  function mount(props: ListProps) {
    return renderSlot({ component: List }, props);
  }

  function isReady(slot: RenderedSlot): boolean {
    return slot.getByRole("status").getAttribute("data-ready") === "true";
  }

  async function advance(milliseconds: number): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(milliseconds);
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    configure({ reactStrictMode: false });
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  afterAll(() => {
    dom.window.close();
  });

  describe("useLifecycleChannelList", () => {
    it("reads on mount and opens readiness on the first answer", async () => {
      const list = pendingList();
      const slot = mount(list);
      assert.equal(list.load.mock.calls.length, 1);
      assert.equal(isReady(slot), false);
      await act(async () => list.requests[0]!.resolve("fresh rows"));
      assert.deepEqual(list.apply.mock.calls, [["fresh rows"]]);
      assert.equal(slot.container.textContent, "fresh rows");
      assert.equal(isReady(slot), true);
      assert.equal(jest.getTimerCount(), 0);
    });

    it("turns 20 lifecycle events into one read per list at 50 ms", async () => {
      const first = pendingList();
      const second = pendingList();
      const slot = renderSlot({ component: ListPair }, { first, second });
      for (let event = 0; event < 20; event += 1) {
        await slot.behavior.emitRealtime("lifecycle", {});
        await advance(1);
      }
      assert.equal(first.load.mock.calls.length, 1);
      assert.equal(second.load.mock.calls.length, 1);
      await advance(29);
      assert.equal(first.load.mock.calls.length, 1);
      assert.equal(second.load.mock.calls.length, 1);
      await advance(1);
      assert.equal(first.load.mock.calls.length, 2);
      assert.equal(second.load.mock.calls.length, 2);
      await act(async () => {
        first.requests[1]!.resolve("lifecycle rows");
        second.requests[1]!.resolve("settled rows");
      });
      assert.deepEqual(first.apply.mock.calls, [["lifecycle rows"]]);
      assert.deepEqual(second.apply.mock.calls, [["settled rows"]]);
    });

    it("keeps each batch deadline fixed during sustained events", async () => {
      const list = pendingList();
      const slot = mount(list);
      for (let window = 0; window < 4; window += 1) {
        await slot.behavior.emitRealtime("lifecycle", {});
        await advance(40);
        await slot.behavior.emitRealtime("lifecycle", {});
        await advance(9);
        assert.equal(list.load.mock.calls.length, window + 1);
        await advance(1);
        assert.equal(list.load.mock.calls.length, window + 2);
      }
    });

    it("drops a stale success during the batch gap but opens readiness", async () => {
      const list = pendingList();
      const slot = mount(list);
      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(20);
      await act(async () => list.requests[0]!.resolve("stale response"));
      assert.deepEqual(list.apply.mock.calls, []);
      assert.equal(slot.container.textContent, "visible rows");
      assert.equal(isReady(slot), true);
      await advance(30);
      await act(async () => list.requests[1]!.resolve("current response"));
      assert.deepEqual(list.apply.mock.calls, [["current response"]]);
    });

    it("does not retry a stale rejection during the batch gap", async () => {
      const list = pendingList();
      const slot = mount(list);
      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(20);
      await act(async () => list.requests[0]!.reject(new Error("old failure")));
      assert.equal(isReady(slot), true);
      assert.equal(jest.getTimerCount(), 1);
      await advance(30);
      await advance(1_000);
      assert.equal(list.load.mock.calls.length, 2);
      assert.equal(jest.getTimerCount(), 0);
    });

    it("keeps visible data and retries failures after 1,000, 2,000, then 4,000 ms", async () => {
      const load = mock(() => Promise.reject(new Error("offline")));
      const apply = mock<(value: string) => void>(() => {});
      const slot = mount({ load, apply });
      await act(async () => {});
      assert.equal(isReady(slot), true);
      assert.equal(slot.container.textContent, "visible rows");
      let calls = 1;
      for (const delay of [1_000, 2_000, 4_000]) {
        await advance(delay - 1);
        assert.equal(load.mock.calls.length, calls);
        await advance(1);
        calls += 1;
        assert.equal(load.mock.calls.length, calls);
      }
      await advance(10_000);
      assert.equal(load.mock.calls.length, 4);
      assert.deepEqual(apply.mock.calls, []);
      assert.equal(jest.getTimerCount(), 0);

      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(50);
      assert.equal(load.mock.calls.length, 5);
      await advance(1_000);
      assert.equal(load.mock.calls.length, 6);
    });

    it("lets a newer event replace a retry and restart its budget", async () => {
      const load = mock(() => Promise.reject(new Error("offline")));
      const slot = mount({ load, apply: () => {} });
      await act(async () => {});
      await advance(800);
      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(50);
      assert.equal(load.mock.calls.length, 2);
      await advance(150);
      assert.equal(load.mock.calls.length, 2);
      await advance(849);
      assert.equal(load.mock.calls.length, 2);
      await advance(1);
      assert.equal(load.mock.calls.length, 3);
    });

    it("reconnects immediately and cancels a pending batch", async () => {
      const list = pendingList();
      const slot = mount(list);
      await slot.behavior.setRealtimeConnectionState("connected");
      assert.equal(list.load.mock.calls.length, 1);
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(20);
      await slot.behavior.setRealtimeConnectionState("connected");
      assert.equal(list.load.mock.calls.length, 2);
      await advance(30);
      assert.equal(list.load.mock.calls.length, 2);
      await act(async () => list.requests[1]!.resolve("after reconnect"));
      await act(async () => list.requests[0]!.resolve("before reconnect"));
      assert.deepEqual(list.apply.mock.calls, [["after reconnect"]]);
    });

    it("reconnects immediately and cancels a pending retry", async () => {
      const list = pendingList();
      const slot = mount(list);
      await act(async () => list.requests[0]!.reject(new Error("offline")));
      await advance(500);
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.setRealtimeConnectionState("connected");
      assert.equal(list.load.mock.calls.length, 2);
      await advance(500);
      assert.equal(list.load.mock.calls.length, 2);
    });

    it("opens readiness at 250 ms even when every request hangs", async () => {
      const list = pendingList();
      const slot = mount(list);
      await advance(249);
      assert.equal(isReady(slot), false);
      await advance(1);
      assert.equal(isReady(slot), true);
      assert.equal(list.load.mock.calls.length, 1);
      assert.deepEqual(list.apply.mock.calls, []);
    });

    it.each(["load", "apply"] as const)(
      "replacing %s disposes pending responses without resetting the readiness deadline",
      async (callback) => {
        const old = pendingList();
        const next = pendingList();
        const slot = mount(old);
        await advance(30);
        const props =
          callback === "load" ? { ...old, load: next.load } : { ...old, apply: next.apply };
        slot.lifecycle.rerender(createElement(List, props));
        const current = callback === "load" ? next.requests[0]! : old.requests[1]!;
        await act(async () => old.requests[0]!.resolve("disposed response"));
        assert.deepEqual(old.apply.mock.calls, []);
        assert.deepEqual(next.apply.mock.calls, []);
        assert.equal(isReady(slot), false);
        await advance(219);
        assert.equal(isReady(slot), false);
        await advance(1);
        assert.equal(isReady(slot), true);
        await act(async () => current.resolve("current response"));
        assert.equal(slot.container.textContent, "current response");
        const currentApply = callback === "load" ? old.apply : next.apply;
        assert.deepEqual(currentApply.mock.calls, [["current response"]]);
      },
    );

    it("callback replacement cancels a scheduled batch", async () => {
      const old = pendingList();
      const next = pendingList();
      const slot = mount(old);
      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(20);
      slot.lifecycle.rerender(createElement(List, next));
      assert.equal(next.load.mock.calls.length, 1);
      await advance(30);
      assert.equal(old.load.mock.calls.length, 1);
      assert.equal(next.load.mock.calls.length, 1);
    });

    it("callback replacement cancels a scheduled retry", async () => {
      const old = pendingList();
      const next = pendingList();
      const slot = mount(old);
      await act(async () => old.requests[0]!.reject(new Error("offline")));
      await advance(500);
      slot.lifecycle.rerender(createElement(List, next));
      assert.equal(next.load.mock.calls.length, 1);
      await advance(500);
      assert.equal(old.load.mock.calls.length, 1);
      assert.equal(next.load.mock.calls.length, 1);
    });

    it.each(["resolve", "reject"] as const)(
      "unmount ignores a late %s and cancels batch and readiness timers",
      async (outcome) => {
        const list = pendingList();
        const slot = mount(list);
        await slot.behavior.emitRealtime("lifecycle", {});
        slot.lifecycle.unmount();
        await act(async () => {
          if (outcome === "resolve") list.requests[0]!.resolve("disposed response");
          else list.requests[0]!.reject(new Error("disposed failure"));
        });
        assert.equal(jest.getTimerCount(), 0);
        await slot.behavior.emitRealtime("lifecycle", {});
        await slot.behavior.setRealtimeConnectionState("reconnecting");
        await slot.behavior.setRealtimeConnectionState("connected");
        await advance(10_000);
        assert.equal(list.load.mock.calls.length, 1);
        assert.deepEqual(list.apply.mock.calls, []);
      },
    );

    it("unmount cancels an already scheduled retry", async () => {
      const list = pendingList();
      const slot = mount(list);
      await act(async () => list.requests[0]!.reject(new Error("offline")));
      assert.equal(jest.getTimerCount(), 1);
      slot.lifecycle.unmount();
      assert.equal(jest.getTimerCount(), 0);
      await advance(10_000);
      assert.equal(list.load.mock.calls.length, 1);
    });

    it.each(["resolve", "reject"] as const)(
      "Strict Mode replay keeps a disposed generation's %s inert",
      async (outcome) => {
        configure({ reactStrictMode: true });
        const list = pendingList();
        const slot = mount(list);
        assert.equal(list.load.mock.calls.length, 2);
        await act(async () => {
          if (outcome === "resolve") list.requests[0]!.resolve("replayed response");
          else list.requests[0]!.reject(new Error("replayed failure"));
        });
        assert.equal(isReady(slot), false);
        assert.deepEqual(list.apply.mock.calls, []);
        assert.equal(jest.getTimerCount(), 1);
        await act(async () => list.requests[1]!.resolve("current response"));
        assert.equal(isReady(slot), true);
        assert.deepEqual(list.apply.mock.calls, [["current response"]]);
        await advance(10_000);
        assert.equal(list.load.mock.calls.length, 2);
        assert.equal(jest.getTimerCount(), 0);
      },
    );

    it("starts event and reconnect reads while older loads remain hung", async () => {
      const list = pendingList();
      const slot = mount(list);
      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(50);
      assert.equal(list.load.mock.calls.length, 2);
      await slot.behavior.emitRealtime("lifecycle", {});
      await advance(50);
      assert.equal(list.load.mock.calls.length, 3);
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.setRealtimeConnectionState("connected");
      assert.equal(list.load.mock.calls.length, 4);
      await act(async () => list.requests[3]!.resolve("recovered response"));
      assert.deepEqual(list.apply.mock.calls, [["recovered response"]]);
      assert.equal(slot.container.textContent, "recovered response");
      await act(async () => {
        list.requests[0]!.resolve("old mount");
        list.requests[1]!.reject(new Error("old batch"));
        list.requests[2]!.resolve("old batch");
      });
      assert.deepEqual(list.apply.mock.calls, [["recovered response"]]);
      assert.equal(jest.getTimerCount(), 0);
    });
  });
}
