import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, it, jest } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

if (process.env.GTD_LIFECYCLE_TEST_CHILD !== "1") {
  it("useLifecycle passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_LIFECYCLE_TEST_CHILD: "1" },
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
  const { act, cleanup, configure, fireEvent, screen } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createElement, Fragment } = await import("react");
  const { Toaster } = await import("sonner");
  const { useLifecycle } = await import("../hooks/use-lifecycle.ts");
  const { snoozeUntilTomorrow } = await import("../lib/lifecycle.ts");

  interface LifecycleRow {
    threadId: string;
    snoozedUntil: number | null;
    snoozedAt: number | null;
  }

  function thread(id: string): PluginSidebarThread {
    return {
      id,
      projectId: "one",
      title: id,
      titleFallback: null,
      parentThreadId: null,
      sectionId: null,
      originKind: null,
      originPluginId: null,
      providerId: "codex",
      hasPendingInteraction: false,
      activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
      indicator: "none",
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      environment: null,
      host: null,
      displayTitle: "",
      lifecycleOwnerThreadId: null,
      sourceThreadId: null,
      status: "idle",
      runtimeStatus: "idle",
      queuedWork: "none",
      pinnedAt: null,
      pinSortKey: null,
      archivedAt: null,
      href: "",
      isHidden: false,
      createdAt: 100,
      updatedAt: 100,
      lastReadAt: 100,
      latestAttentionAt: 100,
    };
  }

  function Probe({ subject }: { subject: PluginSidebarThread }) {
    const lifecycle = useLifecycle();
    return createElement("output", null, lifecycle.shelfFor(subject));
  }

  function mount(rows: () => LifecycleRow[]) {
    return renderSlot(
      { component: Probe },
      { subject: thread("t") },
      {
        rpc: {
          listLifecycle: () => ({ rows: rows() }),
        } as never,
      },
    );
  }

  // The row's Snooze button, beside the Toaster bb mounts for every plugin.
  function SnoozeProbe({ until }: { until: number }) {
    const lifecycle = useLifecycle();
    return createElement(
      Fragment,
      null,
      createElement(
        "button",
        { type: "button", onClick: () => lifecycle.snooze("t", until) },
        "Snooze",
      ),
      createElement(Toaster),
    );
  }

  function mountSnooze(until: number) {
    return renderSlot(
      { component: SnoozeProbe },
      { until },
      {
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          snooze: () => ({ ok: true }),
          unsnooze: () => ({ ok: true }),
        } as never,
      },
    );
  }

  // The rpc resolves first, then Sonner queues its toast on a zero-delay timer.
  async function settle() {
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
  }

  // Newer ICU puts a narrow no-break space before "AM".
  function toastTitles(): string[] {
    return Array.from(document.querySelectorAll("[data-sonner-toast] [data-title]")).map((title) =>
      title.textContent!.replace(/\s/gu, " "),
    );
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

  describe("useLifecycle", () => {
    it("wakes a snooze that already elapsed when its row arrives on a stale clock", async () => {
      const mountedAt = Date.now();
      let rows: LifecycleRow[] = [];
      const slot = mount(() => rows);
      await act(async () => {});
      assert.equal(slot.container.textContent, "active");

      // Nothing is snoozed, so no timer ever armed: the rendered clock is
      // still the mount-time one while the wall clock runs ahead.
      jest.advanceTimersByTime(30_000);

      // Another window parked this thread at t+5s for a t+20s wake. The
      // publish arrives at t+30s: past the wake in wall-clock terms, yet
      // still ahead of the rendered clock.
      rows = [{ threadId: "t", snoozedUntil: mountedAt + 20_000, snoozedAt: mountedAt + 5_000 }];
      await slot.behavior.emitRealtime("lifecycle", { kind: "lifecycle" });
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
      assert.equal(slot.container.textContent, "active");
      assert.equal(jest.getTimerCount(), 0);
    });

    it("still arms a timer for a wake that is ahead of the wall clock", async () => {
      const mountedAt = Date.now();
      let rows: LifecycleRow[] = [];
      const slot = mount(() => rows);
      await act(async () => {});

      rows = [{ threadId: "t", snoozedUntil: mountedAt + 10_000, snoozedAt: mountedAt }];
      await slot.behavior.emitRealtime("lifecycle", { kind: "lifecycle" });
      await act(async () => {
        jest.advanceTimersByTime(50);
      });
      assert.equal(slot.container.textContent, "snoozed");

      await act(async () => {
        jest.advanceTimersByTime(10_100);
      });
      assert.equal(slot.container.textContent, "active");
    });

    it("confirms a snooze with its wake time and undoes it from the toast", async () => {
      const until = snoozeUntilTomorrow(new Date());
      const slot = mountSnooze(until);
      await act(async () => {});
      fireEvent.click(slot.getByRole("button", { name: "Snooze" }));
      await settle();
      // A second press replaces the toast rather than stacking another.
      fireEvent.click(slot.getByRole("button", { name: "Snooze" }));
      await settle();
      assert.deepEqual(toastTitles(), ["Snoozed until tomorrow, 9:00 AM"]);

      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await settle();
      assert.deepEqual(
        slot.inspection.rpcCalls
          .filter(({ method }) => method !== "listLifecycle")
          .map(({ method, input }) => [method, input]),
        [
          ["snooze", { threadId: "t", snoozedUntil: until }],
          ["snooze", { threadId: "t", snoozedUntil: until }],
          ["unsnooze", { threadId: "t" }],
        ],
      );
    });
  });
}
