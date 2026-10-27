import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, it, jest } from "bun:test";
import type { PluginBrowserBbSdk, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { LifecycleApi } from "../hooks/use-lifecycle.ts";

type Reviews = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["list"]>>;

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
  const { useHiddenWorkerActivity } = await import("../hooks/use-hidden-worker-activity.ts");
  const { buildInboxTree } = await import("../lib/inbox-tree.ts");
  const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
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
    const lifecycle = useLifecycle([subject]);
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
    const lifecycle = useLifecycle([thread("t")]);
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
          snooze: () => ({
            ok: true,
            rows: [{ threadId: "t", snoozedUntil: until, snoozedAt: Date.now() }],
          }),
          unsnooze: () => ({ ok: true, rows: [] }),
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

  describe("review activity", () => {
    const review = (
      id = "review",
      status = "active" as "active" | "idle" | "error",
    ): Reviews[number] => ({
      ...makeThreadResponse({
        id,
        parentThreadId: "parent",
        originPluginId: "review",
        visibility: "hidden",
        status,
      }),
      activity: {
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activeGoalCount: 0,
        activePlanModeCount: 0,
        activeWorkflowCount: 0,
      },
      environmentBranchName: null,
      environmentHostId: null,
      environmentIsWorktree: null,
      environmentName: null,
      environmentPath: null,
      environmentProviderId: null,
      environmentWorkspaceDisplayKind: "other",
      hasPendingInteraction: false,
      pinSortKey: null,
      queuedWork: "none",
    });

    function ReviewProbe({ subjects }: { subjects: PluginSidebarThread[] }) {
      const threads = useHiddenWorkerActivity(subjects);
      const lifecycle = useLifecycle(threads);
      const tree = buildInboxTree(threads, (thread) => lifecycle.shelfFor(thread));
      return createElement(
        "output",
        null,
        tree
          .map((node) => `${node.thread.id}:${node.shelf}:${lifecycle.canPark(node.thread)}`)
          .join(","),
      );
    }

    async function mountReviews(
      list: PluginBrowserBbSdk["threads"]["list"],
      subjects = [thread("parent"), thread("other")],
      snoozed = false,
    ) {
      let notify = (_change: string) => {};
      const slot = renderSlot(
        { component: ReviewProbe },
        { subjects },
        {
          sdk: {
            threads: { list },
            subscribe: ({ callback }) => {
              notify = (change) => callback({ id: "review", changes: [change] } as never);
              return () => {
                notify = () => {};
              };
            },
          },
          rpc: {
            listLifecycle: () => ({
              rows: snoozed
                ? [
                    {
                      threadId: "parent",
                      snoozedAt: Date.now(),
                      snoozedUntil: Date.now() + 60_000,
                    },
                  ]
                : [],
            }),
          } as never,
        },
      );
      await flush();
      return {
        slot,
        signal: (kind = "status-changed") => notify(kind),
        change: async (kind = "status-changed") => {
          await act(async () => notify(kind));
          await act(async () => {
            jest.advanceTimersByTime(250);
          });
        },
      };
    }

    it("coalesces bursts and waits for an in-flight lookup before reading again", async () => {
      let finish!: (rows: Reviews) => void;
      const pending = new Promise<Reviews>((resolve) => {
        finish = resolve;
      });
      let calls = 0;
      let response = pending;
      const { signal } = await mountReviews(() => {
        calls += 1;
        return response;
      });
      assert.equal(calls, 2);
      await act(async () => {
        for (let i = 0; i < 10; i++) signal();
      });
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      assert.equal(calls, 2);
      response = Promise.resolve([]);
      await act(async () => finish([review()]));
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      assert.equal(calls, 4);
      await act(async () => {
        for (let i = 0; i < 10; i++) signal();
      });
      await act(async () => {
        jest.advanceTimersByTime(249);
      });
      assert.equal(calls, 4);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      assert.equal(calls, 6);
    });

    it("keeps an idle parent waiting until every hidden review finishes", async () => {
      let reviews = [review(), review("second")];
      const { slot, change } = await mountReviews(async () => reviews);
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      reviews = [review("review", "idle"), review("second")];
      await change();
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      reviews = [review("review", "idle"), review("second", "error")];
      await change();
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:nextAction:true");
    });

    it("keeps questions actionable and pinned threads pinned during a review", async () => {
      const { slot } = await mountReviews(
        async () => [review(), { ...review("pinned-review"), parentThreadId: "pinned" }],
        [
          { ...thread("parent"), hasPendingInteraction: true },
          { ...thread("pinned"), isPinned: true },
        ],
      );
      assert.equal(slot.container.textContent, "pinned:pinned:false,parent:nextAction:false");
    });

    it("keeps the launching thread waiting while hidden Arena workers run", async () => {
      const arena = (status: "active" | "idle") => ({
        ...review("arena-worker", status),
        parentThreadId: null,
        lifecycleOwnerThreadId: "parent",
        originPluginId: "scott-engineering",
      });
      let workers = [arena("active")];
      const { slot, change } = await mountReviews(async (args) =>
        args?.originPluginId === "scott-engineering" ? workers : [],
      );
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      workers = [arena("idle")];
      await change();
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:nextAction:true");
    });

    it("wakes a snoozed parent when a hidden review starts", async () => {
      let reviews: Reviews = [];
      const { slot, change } = await mountReviews(async () => reviews, [thread("parent")], true);
      assert.equal(slot.container.textContent, "parent:snoozed:true");
      reviews = [review()];
      await change("thread-created");
      assert.equal(slot.container.textContent, "parent:waiting:false");
    });

    it("moves review activity with its parent and clears it when removed", async () => {
      let reviews = [review()];
      const { slot, change } = await mountReviews(async () => reviews);
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      reviews = [{ ...review(), parentThreadId: "other" }];
      await change("parent-changed");
      assert.equal(slot.container.textContent, "parent:nextAction:true,other:waiting:false");
      reviews = [];
      await change("thread-deleted");
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:nextAction:true");
    });

    it("applies a lookup that finishes after a change, then reads again", async () => {
      let resolve!: (reviews: Reviews) => void;
      let response = new Promise<Reviews>((done) => {
        resolve = done;
      });
      const { slot, change } = await mountReviews(() => response);
      response = Promise.resolve([review("review", "idle")]);
      await change();
      // Lookups never overlap, so the one that just finished is the newest.
      await act(async () => resolve([review()]));
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:nextAction:true");
      response = Promise.resolve([review()]);
      await change();
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
    });

    it("reads at least once a second through a steady stream of changes", async () => {
      let calls = 0;
      const { signal } = await mountReviews(async () => {
        calls += 1;
        return [];
      });
      assert.equal(calls, 2);
      for (let tick = 0; tick < 5; tick++) {
        await act(async () => signal());
        await act(async () => {
          jest.advanceTimersByTime(200);
        });
      }
      assert.equal(calls, 4);
    });

    it("preserves Waiting across a read failure and retries completion", async () => {
      let response = () => Promise.resolve([review()]);
      const { slot, change } = await mountReviews(() => response());
      response = () => Promise.reject(new Error("offline"));
      await change();
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      response = () => Promise.resolve([review("review", "idle")]);
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:nextAction:true");
    });

    it("reconciles missed completion after reconnect", async () => {
      let reviews = [review()];
      let calls = 0;
      const { slot } = await mountReviews(async () => {
        calls += 1;
        return reviews;
      });
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      reviews = [];
      await slot.behavior.setRealtimeConnectionState("connected");
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:nextAction:true");
      slot.lifecycle.unmount();
      const before = calls;
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      assert.equal(calls, before);
    });

    it("cancels a scheduled retry and its lookup signal on unmount", async () => {
      let fail = false;
      let calls = 0;
      let signal: AbortSignal | undefined;
      const { slot, change } = await mountReviews(async (args) => {
        calls += 1;
        signal = args?.signal;
        if (fail) throw new Error("offline");
        return [review()];
      });
      assert.equal(slot.container.textContent, "other:nextAction:true,parent:waiting:false");
      fail = true;
      await change();
      assert.equal(signal?.aborted, false);
      slot.lifecycle.unmount();
      assert.equal(signal?.aborted, true);
      // The retry that was due never runs.
      const before = calls;
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      assert.equal(calls, before);
    });
  });

  describe("useLifecycle", () => {
    /** The stored rows after parking the family until `until`. */
    function familyRows(until: number): LifecycleRow[] {
      return ["t", "child"].map((threadId) => ({
        threadId,
        snoozedAt: Date.now(),
        snoozedUntil: until,
      }));
    }

    function EditableProbe({ attentionAt = 100 }: { attentionAt?: number }) {
      const subjects = [
        { ...thread("t"), latestAttentionAt: attentionAt },
        { ...thread("child"), parentThreadId: "t" },
      ];
      const lifecycle = useLifecycle(subjects);
      return createElement(
        Fragment,
        null,
        createElement(
          "output",
          null,
          subjects.map((subject) => lifecycle.shelfFor(subject)).join(","),
        ),
        createElement(
          "button",
          { onClick: () => lifecycle.snooze("t", Date.now() + 60_000) },
          "Park",
        ),
        createElement("button", { onClick: () => lifecycle.unsnooze("t") }, "Wake"),
      );
    }

    it("parks a whole family before the write resolves and rolls back a failed write", async () => {
      let fail!: (error: Error) => void;
      const pending = new Promise((_resolve, reject) => {
        fail = reject;
      });
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            snooze: () => pending,
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
      await act(async () => fail(new Error("offline")));
      assert.equal(slot.getByRole("status").textContent, "active,active");
    });

    it("wakes a family before the write resolves and restores it on failure", async () => {
      let fail!: (error: Error) => void;
      const pending = new Promise((_resolve, reject) => {
        fail = reject;
      });
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => ({
              rows: ["t", "child"].map((threadId) => ({
                threadId,
                snoozedAt: Date.now(),
                snoozedUntil: Date.now() + 60_000,
              })),
            }),
            unsnooze: () => pending,
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Wake" }));
      assert.equal(slot.getByRole("status").textContent, "active,active");
      await act(async () => fail(new Error("offline")));
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
    });

    // Separate requests can arrive out of order, so the Undo waits for its
    // snooze to answer; it still draws on the click.
    it("draws a fast Undo at once and sends it after the snooze answers", async () => {
      let finish!: (value: { ok: boolean; rows: LifecycleRow[] }) => void;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      const calls: string[] = [];
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            snooze: () => {
              calls.push("park");
              return pending;
            },
            unsnooze: () => {
              calls.push("wake");
              return { ok: true, rows: [] };
            },
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      fireEvent.click(slot.getByRole("button", { name: "Wake" }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "active,active");
      assert.deepEqual(calls, ["park"]);
      await act(async () => finish({ ok: true, rows: familyRows(Date.now() + 60_000) }));
      await flush();
      assert.deepEqual(calls, ["park", "wake"]);
      assert.equal(slot.getByRole("status").textContent, "active,active");
    });

    // bb has nothing to predict on before the first read lands.
    it("parks a family clicked before the first read lands and keeps it once the write answers", async () => {
      let answer!: (value: { ok: boolean; rows: LifecycleRow[] }) => void;
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => new Promise(() => {}),
            snooze: () =>
              new Promise((resolve) => {
                answer = resolve;
              }),
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
      await flush();
      await act(async () => answer({ ok: true, rows: familyRows(Date.now() + 60_000) }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
    });

    it("keeps a saved park on screen when the first read then fails", async () => {
      let failRead!: (error: Error) => void;
      const read = new Promise((_resolve, reject) => {
        failRead = reject;
      });
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => read,
            snooze: () => ({ ok: true, rows: familyRows(Date.now() + 60_000) }),
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
      await act(async () => failRead(new Error("offline")));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
    });

    it("drops a park clicked before the first read lands when its write fails", async () => {
      let fail!: (error: Error) => void;
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => new Promise(() => {}),
            snooze: () =>
              new Promise((_resolve, reject) => {
                fail = reject;
              }),
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
      await flush();
      await act(async () => fail(new Error("offline")));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "active,active");
    });

    it("parks a family whose latest attention is ahead of the browser clock", async () => {
      // bb stamps attention on the server's clock, which may run ahead of this one.
      const slot = renderSlot(
        { component: EditableProbe },
        { attentionAt: Date.now() + 5_000 },
        {
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            snooze: () => new Promise(() => {}),
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
    });

    it("keeps a snooze drawn over a re-read that started before it", async () => {
      let reads = 0;
      let stored: LifecycleRow[] = [];
      let finishRead!: (value: { rows: LifecycleRow[] }) => void;
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => {
              reads += 1;
              if (reads !== 2) return { rows: stored };
              return new Promise((resolve) => {
                finishRead = resolve;
              });
            },
            snooze: () => {
              stored = familyRows(Date.now() + 60_000);
              return { ok: true, rows: stored };
            },
          } as never,
        },
      );
      await flush();
      void slot.behavior.experimental_invalidateRpc(["lifecycle"]);
      await flush();
      assert.equal(reads, 2);
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
      // The stale answer is dropped and the read runs again after the write.
      await act(async () => finishRead({ rows: [] }));
      await flush();
      assert.equal(reads, 3);
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
    });

    it("ends on a newer read when an older write answers late", async () => {
      // This window parks the family and its answer is slow. Meanwhile another
      // window wakes it, and this window's re-read already shows the wake.
      let stored: LifecycleRow[] = [];
      let answer!: (value: { ok: boolean; rows: LifecycleRow[] }) => void;
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => ({ rows: stored }),
            snooze: () =>
              new Promise((resolve) => {
                answer = resolve;
              }),
          } as never,
        },
      );
      await flush();
      fireEvent.click(slot.getByRole("button", { name: "Park" }));
      await flush();
      const parked = familyRows(Date.now() + 60_000);
      stored = [];
      await slot.behavior.experimental_invalidateRpc(["lifecycle"]);
      await flush();
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
      // The answer is the snapshot from when the park ran, before the wake.
      await act(async () => answer({ ok: true, rows: parked }));
      await flush();
      assert.equal(slot.getByRole("status").textContent, "active,active");
    });

    it("keeps the shelves when a refresh fails", async () => {
      let fail = false;
      const slot = renderSlot(
        { component: EditableProbe },
        {},
        {
          rpc: {
            listLifecycle: () => {
              if (fail) throw new Error("offline");
              return { rows: familyRows(Date.now() + 60_000) };
            },
          } as never,
        },
      );
      await flush();
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
      fail = true;
      await slot.behavior.experimental_invalidateRpc(["lifecycle"]);
      await flush();
      assert.equal(slot.getByRole("status").textContent, "snoozed,snoozed");
    });

    // Most refreshes re-read a list that has not changed. Keeping the same
    // answer is what stops each of those from re-partitioning the sidebar.
    it("keeps its classification when a refresh changes nothing", async () => {
      const seen: LifecycleApi[] = [];
      const rows = familyRows(Date.now() + 60_000);
      function IdentityProbe() {
        seen.push(useLifecycle([thread("t")]));
        return null;
      }
      const slot = renderSlot(
        { component: IdentityProbe },
        {},
        { rpc: { listLifecycle: () => ({ rows }) } as never },
      );
      await flush();
      const settled = seen.at(-1);
      await slot.behavior.experimental_invalidateRpc(["lifecycle"]);
      await flush();
      assert.equal(seen.at(-1), settled);
    });

    it("wakes a snooze that already elapsed when its row arrives on a stale clock", async () => {
      const mountedAt = Date.now();
      let rows: LifecycleRow[] = [];
      const slot = mount(() => rows);
      await flush();
      assert.equal(slot.container.textContent, "active");

      // Nothing is snoozed, so no timer ever armed: the rendered clock is
      // still the mount-time one while the wall clock runs ahead.
      jest.advanceTimersByTime(30_000);
      // bb's query cache keeps timers of its own.
      const cacheTimers = jest.getTimerCount();

      // Another window parked this thread at t+5s for a t+20s wake. The
      // refresh arrives at t+30s: past the wake in wall-clock terms, yet
      // still ahead of the rendered clock.
      rows = [{ threadId: "t", snoozedUntil: mountedAt + 20_000, snoozedAt: mountedAt + 5_000 }];
      await slot.behavior.experimental_invalidateRpc(["lifecycle"]);
      await flush();
      assert.equal(slot.container.textContent, "active");
      assert.equal(jest.getTimerCount(), cacheTimers);
    });

    it("still arms a timer for a wake that is ahead of the wall clock", async () => {
      const mountedAt = Date.now();
      let rows: LifecycleRow[] = [];
      const slot = mount(() => rows);
      await flush();

      rows = [{ threadId: "t", snoozedUntil: mountedAt + 10_000, snoozedAt: mountedAt }];
      await slot.behavior.experimental_invalidateRpc(["lifecycle"]);
      await flush();
      assert.equal(slot.container.textContent, "snoozed");

      await act(async () => {
        jest.advanceTimersByTime(10_100);
      });
      assert.equal(slot.container.textContent, "active");
    });

    it("confirms a snooze with its wake time and undoes it from the toast", async () => {
      const until = snoozeUntilTomorrow(new Date());
      const slot = mountSnooze(until);
      await flush();
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
