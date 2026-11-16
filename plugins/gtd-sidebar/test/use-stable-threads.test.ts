import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

if (process.env.GTD_STABLE_THREADS_TEST_CHILD !== "1") {
  it("useStableThreads passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_STABLE_THREADS_TEST_CHILD: "1" },
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
  const { cleanup, configure, render } = await import("@testing-library/react");
  const { createElement } = await import("react");
  const { useStableThreads } = await import("../hooks/use-stable-threads.ts");

  type Thread = PluginSidebarThread;

  function thread(id: string, title: string): Thread {
    return { id, title, tags: ["a"] } as unknown as Thread;
  }

  /** bb rebuilds every thread object even when nothing changed. */
  function rebuilt(threads: readonly Thread[]): Thread[] {
    return threads.map((entry) => structuredClone(entry));
  }

  let renders = 0;
  let returned: readonly Thread[] = [];
  function record(list: readonly Thread[]) {
    renders += 1;
    returned = list;
  }

  function Probe({
    threads,
    onRender,
  }: {
    threads: readonly Thread[];
    onRender: (list: readonly Thread[]) => void;
  }) {
    onRender(useStableThreads(threads));
    return null;
  }

  function mount(threads: readonly Thread[]) {
    return render(createElement(Probe, { threads, onRender: record }));
  }

  /** Render passes and the returned list for one new input. */
  function feed(view: ReturnType<typeof render>, threads: readonly Thread[]) {
    const before = renders;
    view.rerender(createElement(Probe, { threads, onRender: record }));
    return { passes: renders - before, list: returned };
  }

  beforeEach(() => {
    configure({ reactStrictMode: false });
    renders = 0;
  });

  afterEach(cleanup);

  describe("useStableThreads", () => {
    it("returns the stored list for a rebuilt but equal list, in one pass", () => {
      const first = [thread("a", "A"), thread("b", "B")];
      const view = mount(first);
      assert.equal(renders, 1);
      const mounted = returned;

      for (let round = 0; round < 3; round++) {
        const next = feed(view, rebuilt(first));
        assert.equal(next.passes, 1);
        assert.equal(next.list, mounted);
      }
    });

    it("keeps unchanged threads across a real change and settles in one extra pass", () => {
      const view = mount([thread("a", "A"), thread("b", "B")]);
      const [keptA] = returned;

      const changed = feed(view, [thread("a", "A"), thread("b", "Renamed")]);
      assert.equal(changed.passes, 2);
      assert.equal(changed.list[0], keptA);
      assert.equal(changed.list[1]?.title, "Renamed");

      // The stored list is now the changed one: an equal rebuild costs no extra pass.
      const settled = feed(view, rebuilt(changed.list));
      assert.equal(settled.passes, 1);
      assert.equal(settled.list, changed.list);
    });

    it("converges when bb lists the same id twice", () => {
      const twice = [thread("t", "First"), thread("t", "Second"), thread("u", "U")];
      const view = mount(twice);

      let input: readonly Thread[] = twice;
      for (let round = 0; round < 3; round++) {
        input = rebuilt(twice);
        const next = feed(view, input);
        assert.ok(next.passes <= 2, `took ${next.passes} passes`);
        assert.deepEqual(
          next.list.map((entry) => entry.title),
          ["First", "Second", "U"],
        );
      }
      // Re-rendering with the same input array computes nothing new.
      const last = returned;
      const same = feed(view, input);
      assert.equal(same.passes, 1);
      assert.equal(same.list, last);
    });
  });
}
