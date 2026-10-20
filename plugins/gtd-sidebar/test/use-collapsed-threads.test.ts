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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function FoldProbe() {
    const { collapsedThreads, toggleThread } = useCollapsedThreads();
    return createElement(
      Fragment,
      null,
      createElement("output", null, [...collapsedThreads].sort().join(",")),
      createElement("button", { type: "button", onClick: () => toggleThread("t") }, "Fold"),
    );
  }

  /**
   * A window over a thread-list store: `stored` is what any read returns,
   * and each fold write waits until the test answers it.
   */
  async function mountFolds(initial: string[] = []) {
    const state = { stored: initial, reads: 0 };
    const writes: ReturnType<typeof deferred<Folds>>[] = [];
    const slot = renderSlot(
      { component: FoldProbe },
      {},
      {
        rpc: {
          listCollapsedThreads: () => {
            state.reads += 1;
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
    await act(async () => {});
    return {
      slot,
      state,
      writes,
      folds: () => slot.getByRole("status").textContent,
      fold: () => fireEvent.click(slot.getByRole("button", { name: "Fold" })),
      /** Another sidebar changed the folds and the backend published it. */
      publish: async () => {
        await slot.behavior.emitRealtime("lifecycle", { kind: "collapsed" });
        await act(async () => {
          jest.advanceTimersByTime(50);
        });
      },
      settle: async () => {
        await act(async () => {});
        await act(async () => {});
      },
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
    it("folds on the click and writes the fold it wants", async () => {
      const window = await mountFolds();
      window.fold();
      assert.equal(window.folds(), "t");
      window.fold();
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
      await act(async () => window.writes[0]!.reject(new Error("thread-list is off")));
      await window.settle();
      assert.equal(window.folds(), "t");
    });

    it("catches up on a change it dropped once the fold settles", async () => {
      const window = await mountFolds();
      window.fold();
      // bb's sidebar folds another family after this window's write landed.
      window.state.stored = ["t", "x"];
      await window.publish();
      assert.equal(window.folds(), "t");
      const readsBeforeAnswer = window.state.reads;
      // The answer predates bb's fold; the backend will not publish it again.
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
      await act(async () => {});
      await slot.behavior.emitRealtime("lifecycle", { kind: "collapsed" });
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
      assert.equal(reads, 2);
      fireEvent.click(slot.getByRole("button", { name: "Fold" }));
      stored = ["t", "x"];
      await act(async () => writes[0]!.resolve({ threadIds: ["t"] }));
      await act(async () => {});
      assert.equal(reads, 3);
      // The older read answers last and changes nothing.
      await act(async () => finishRead({ threadIds: [] }));
      assert.equal(slot.getByRole("status").textContent, "t,x");
    });
  });
}
