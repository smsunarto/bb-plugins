import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, it, jest } from "bun:test";

if (process.env.GTD_COLLAPSED_TEST_CHILD !== "1") {
  it("useCollapsedThreads passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_COLLAPSED_TEST_CHILD: "1" },
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
  const { act, cleanup, configure, fireEvent } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createElement, Fragment } = await import("react");
  const { useCollapsedThreads } = await import("../hooks/use-collapsed-threads.ts");

  interface Folds {
    threadIds: string[];
  }

  // bb's cached reads answer, then TanStack Query notifies on a zero-delay
  // timer, which the fake clock holds until it moves.
  async function flush() {
    for (let round = 0; round < 2; round++) {
      await act(async () => {});
      await act(async () => {
        jest.advanceTimersByTime(0);
      });
    }
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

  function FoldProbe({ familyIds }: { familyIds?: readonly string[] }) {
    const { collapsedThreads, toggleThread } = useCollapsedThreads(familyIds);
    return createElement(
      Fragment,
      null,
      createElement("output", null, [...collapsedThreads].sort().join(",")),
      createElement("button", { type: "button", onClick: () => toggleThread("t") }, "Fold"),
    );
  }

  /**
   * A window over a thread-list store: `stored` is what any read returns,
   * and each fold write waits until the test answers it. A read waits for
   * `held` while it is set.
   */
  async function mountFolds(initial: string[] = []) {
    const state = {
      stored: initial,
      reads: 0,
      held: null as ReturnType<typeof deferred<void>> | null,
    };
    const writes: ReturnType<typeof deferred<Folds>>[] = [];
    const slot = renderSlot(
      { component: FoldProbe },
      {},
      {
        rpc: {
          listCollapsedThreads: async () => {
            state.reads += 1;
            await state.held?.promise;
            return { threadIds: state.stored };
          },
          setThreadCollapsed: () => {
            const write = deferred<Folds>();
            writes.push(write);
            return write.promise;
          },
        } as never,
      },
    );
    await flush();
    return {
      slot,
      state,
      writes,
      folds: () => slot.getByRole("status").textContent,
      fold: () => fireEvent.click(slot.getByRole("button", { name: "Fold" })),
      /** Another sidebar changed the folds and the backend invalidated the read. */
      publish: async () => {
        await slot.behavior.experimental_invalidateRpc(["collapsed"]);
        await flush();
      },
      settle: flush,
    };
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

  describe("useCollapsedThreads", () => {
    it("loads a saved expansion despite roster updates with the same families", async () => {
      const pending = deferred<Folds>();
      let reads = 0;
      const slot = renderSlot(
        { component: FoldProbe },
        { familyIds: ["t"] },
        {
          rpc: {
            listCollapsedThreads: () => {
              reads += 1;
              return pending.promise;
            },
          } as never,
        },
      );
      slot.lifecycle.rerender(createElement(FoldProbe, { familyIds: ["t"] }));
      await act(async () => pending.resolve({ threadIds: [] }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "");
      assert.equal(reads, 1);
    });

    it("keeps the last folds while a new family set loads", async () => {
      const second = deferred<Folds>();
      const slot = renderSlot(
        { component: FoldProbe },
        { familyIds: ["a"] },
        {
          rpc: {
            listCollapsedThreads: ({ familyIds }: { familyIds: string[] }) =>
              familyIds.length === 1 ? { threadIds: [] } : second.promise,
          } as never,
        },
      );
      await flush();
      assert.equal(slot.getByRole("status").textContent, "");
      slot.lifecycle.rerender(createElement(FoldProbe, { familyIds: ["a", "b"] }));
      await flush();
      // `a` keeps its saved expansion; only the new family waits folded.
      assert.equal(slot.getByRole("status").textContent, "b");
      await act(async () => second.resolve({ threadIds: ["b"] }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "b");
    });

    it("keeps new families folded while loading and expands on the first click", async () => {
      // Every read is slow, and still out when the expansion saves.
      const reads = deferred<void>();
      let stored = ["t"];
      const slot = renderSlot(
        { component: FoldProbe },
        { familyIds: ["t"] },
        {
          rpc: {
            listCollapsedThreads: async () => {
              await reads.promise;
              return { threadIds: stored };
            },
            setThreadCollapsed: () => {
              stored = [];
              return { threadIds: stored };
            },
          } as never,
        },
      );
      assert.equal(slot.getByRole("status").textContent, "t");
      fireEvent.click(slot.getByRole("button", { name: "Fold" }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "");
      assert.deepEqual(
        slot.inspection.rpcCalls.find(({ method }) => method === "setThreadCollapsed")?.input,
        { threadId: "t", collapsed: false },
      );
      await act(async () => reads.resolve());
      await flush();
      assert.equal(slot.getByRole("status").textContent, "");
    });

    // bb predicts on the read keyed by the families at the click; the roster
    // can move back to another family set's cached read before the write lands.
    it("holds a pending fold when the roster returns to a cached family set", async () => {
      let stored: string[] = [];
      const write = deferred<Folds>();
      const slot = renderSlot(
        { component: FoldProbe },
        { familyIds: ["t"] },
        {
          rpc: {
            listCollapsedThreads: () => ({ threadIds: stored }),
            setThreadCollapsed: () => write.promise,
          } as never,
        },
      );
      await flush();
      slot.lifecycle.rerender(createElement(FoldProbe, { familyIds: ["t", "u"] }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "");
      fireEvent.click(slot.getByRole("button", { name: "Fold" }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "t");
      slot.lifecycle.rerender(createElement(FoldProbe, { familyIds: ["t"] }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "t");
      stored = ["t"];
      await act(async () => write.resolve({ threadIds: stored }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "t");
    });

    // The roster moved back to a cached read without the fold; its refresh
    // after the save fails, so nothing has shown the saved fold there yet.
    it("keeps a saved fold on another family set's read until one lands", async () => {
      let stored: string[] = [];
      let readsFail = false;
      const write = deferred<Folds>();
      const slot = renderSlot(
        { component: FoldProbe },
        { familyIds: ["t"] },
        {
          rpc: {
            listCollapsedThreads: () => {
              if (readsFail) throw new Error("thread-list is off");
              return { threadIds: stored };
            },
            setThreadCollapsed: () => write.promise,
          } as never,
        },
      );
      await flush();
      slot.lifecycle.rerender(createElement(FoldProbe, { familyIds: ["t", "u"] }));
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Fold" }));
      slot.lifecycle.rerender(createElement(FoldProbe, { familyIds: ["t"] }));
      await flush();
      readsFail = true;
      stored = ["t"];
      await act(async () => write.resolve({ threadIds: stored }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "t");
      // Another window opens the family; the next read that lands wins.
      readsFail = false;
      stored = [];
      await slot.behavior.experimental_invalidateRpc(["collapsed"]);
      await flush();
      assert.equal(slot.getByRole("status").textContent, "");
    });

    it("folds on the click and writes the fold it wants", async () => {
      const window = await mountFolds();
      window.fold();
      assert.equal(window.folds(), "t");
      window.fold();
      assert.equal(window.folds(), "");
      await window.settle();
      assert.equal(window.folds(), "");
      assert.deepEqual(
        window.slot.inspection.rpcCalls
          .filter(({ method }) => method === "setThreadCollapsed")
          .map(({ input }) => input),
        [
          { threadId: "t", collapsed: true },
          { threadId: "t", collapsed: false },
        ],
      );
    });

    it("drops a read that overlaps a fold", async () => {
      const window = await mountFolds();
      window.fold();
      // The read predates the fold on the backend, so it would reopen it.
      await window.publish();
      assert.equal(window.folds(), "t");
      window.state.stored = ["t"];
      await act(async () => window.writes[0]!.resolve({ threadIds: ["t"] }));
      await window.settle();
      assert.equal(window.folds(), "t");
    });

    it("lands only the newest fold's answer", async () => {
      const window = await mountFolds();
      window.fold();
      window.fold();
      await window.settle();
      assert.equal(window.folds(), "");
      await act(async () => window.writes[1]!.resolve({ threadIds: [] }));
      // The fold's answer arrives last; landing it would refold an open family.
      await act(async () => window.writes[0]!.resolve({ threadIds: ["t"] }));
      await window.settle();
      assert.equal(window.folds(), "");
    });

    it("keeps a fold on screen when its write fails", async () => {
      const window = await mountFolds();
      window.fold();
      await window.settle();
      await act(async () => window.writes[0]!.reject(new Error("thread-list is off")));
      await window.settle();
      assert.equal(window.folds(), "t");
    });

    it("lets the next read replace a fold its write failed to save", async () => {
      const window = await mountFolds();
      window.fold();
      await window.settle();
      await act(async () => window.writes[0]!.reject(new Error("thread-list is off")));
      await window.settle();
      // thread-list returns, and another window's read keeps the family open.
      window.state.held = deferred();
      const refreshed = window.slot.behavior.experimental_invalidateRpc(["collapsed"]);
      await window.settle();
      assert.equal(window.folds(), "t");
      await act(async () => window.state.held!.resolve());
      await refreshed;
      await window.settle();
      assert.equal(window.folds(), "");
    });

    it("lets another window's folds replace a fold its write failed to save", async () => {
      const window = await mountFolds(["t"]);
      window.fold();
      await window.settle();
      await act(async () => window.writes[0]!.reject(new Error("thread-list is off")));
      await window.settle();
      assert.equal(window.folds(), "");
      window.state.stored = ["t", "x"];
      await window.publish();
      assert.equal(window.folds(), "t,x");
    });

    it("shows another sidebar's fold while its own is pending, and reads again once it settles", async () => {
      const window = await mountFolds();
      window.fold();
      // bb's sidebar folds another family after this window's write landed.
      window.state.stored = ["t", "x"];
      await window.publish();
      assert.equal(window.folds(), "t,x");
      const readsBeforeAnswer = window.state.reads;
      // The answer predates bb's fold, so a read after it is what stands.
      await act(async () => window.writes[0]!.resolve({ threadIds: ["t"] }));
      await window.settle();
      assert.equal(window.state.reads, readsBeforeAnswer + 1);
      assert.equal(window.folds(), "t,x");
    });

    it("replaces a read still in flight when the fold settles", async () => {
      let finishRead!: (value: Folds) => void;
      let reads = 0;
      let stored: string[] = [];
      const writes: ReturnType<typeof deferred<Folds>>[] = [];
      const slot = renderSlot(
        { component: FoldProbe },
        {},
        {
          rpc: {
            listCollapsedThreads: () => {
              reads += 1;
              if (reads !== 2) return { threadIds: stored };
              return new Promise((resolve) => {
                finishRead = resolve;
              });
            },
            setThreadCollapsed: () => {
              const write = deferred<Folds>();
              writes.push(write);
              return write.promise;
            },
          } as never,
        },
      );
      await flush();
      void slot.behavior.experimental_invalidateRpc(["collapsed"]);
      await flush();
      assert.equal(reads, 2);
      fireEvent.click(slot.getByRole("button", { name: "Fold" }));
      await flush();
      stored = ["t", "x"];
      await act(async () => writes[0]!.resolve({ threadIds: ["t"] }));
      // The older read answers last and changes nothing; a newer one replaces it.
      await act(async () => finishRead({ threadIds: [] }));
      await flush();
      assert.equal(reads, 3);
      assert.equal(slot.getByRole("status").textContent, "t,x");
    });
  });
}
