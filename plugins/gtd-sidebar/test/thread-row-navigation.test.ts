import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, it, mock, spyOn } from "bun:test";
import type {
  BbNavigate,
  PluginSidebarPullRequest,
  PluginSidebarThread,
  PluginSidebarThreadActions,
  PluginSidebarThreadsState,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PointerEvent } from "react";
import type { LifecycleApi } from "../hooks/use-lifecycle.ts";
import type { SettledThreadsApi } from "../hooks/use-settled-threads.ts";

if (process.env.GTD_ROW_NAVIGATION_TEST_CHILD !== "1") {
  it("thread row navigation passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_ROW_NAVIGATION_TEST_CHILD: "1" },
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
    if (name in globalThis && name !== "Event" && name !== "CustomEvent") continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: Reflect.get(dom.window, name),
      writable: true,
    });
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const { act, cleanup, configure, fireEvent, screen, within } =
    await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createContext, createElement, startTransition, Suspense, useContext } =
    await import("react");
  const sdk = { ...(await import("@get-bb/plugin-sdk/app")) };

  interface HostState {
    sidebar: PluginSidebarThreadsState;
    actions: Partial<PluginSidebarThreadActions>;
    navigate: Partial<BbNavigate>;
    lifecycle: LifecycleApi;
    settled: SettledThreadsApi;
    pullRequests: Readonly<Record<string, PluginSidebarPullRequest>>;
    splitThreads: readonly string[];
    splitEnabled: boolean;
    onSplitPointerDown: (threadId: string, event: PointerEvent<HTMLElement>) => void;
  }

  const HostContext = createContext<HostState | null>(null);
  function useHost() {
    const host = useContext(HostContext);
    assert.ok(host);
    return host;
  }
  const useActions = mock(() => ({
    ...sdk.experimental_useSidebarThreadActions(),
    ...useHost().actions,
  }));
  mock.module("@get-bb/plugin-sdk/app", () => ({
    ...sdk,
    experimental_useSidebarThreads: () => useHost().sidebar,
    experimental_useSidebarThreadActions: useActions,
    useBbNavigate: () => ({ ...sdk.useBbNavigate(), ...useHost().navigate }),
    experimental_useSidebarThreadSplit: (threadId: string) => {
      const host = useHost();
      return {
        isAvailable: host.splitEnabled,
        layout: host.splitThreads.includes(threadId) ? { panes: [] } : null,
        splitProps: host.splitEnabled
          ? {
              onPointerDown: (event: PointerEvent<HTMLElement>) =>
                host.onSplitPointerDown(threadId, event),
            }
          : {},
      };
    },
    experimental_useSidebarThreadPullRequest: (threadId: string) => ({
      isLoading: false,
      pullRequest: useHost().pullRequests[threadId] ?? null,
    }),
  }));
  mock.module("../hooks/use-lifecycle.ts", () => ({ useLifecycle: () => useHost().lifecycle }));
  mock.module("../hooks/use-settled-threads.ts", () => ({
    useSettledThreads: () => useHost().settled,
  }));
  const rowBodyRender = spyOn(
    await import("../components/inbox/row-context-menu.tsx"),
    "RowContextMenu",
  );
  const { ThreadInbox } = await import("../components/inbox/thread-inbox.tsx");
  const { useCommittedEvent } = await import("../hooks/use-committed-event.ts");

  interface EventProbeProps {
    callback: () => void;
    observe: (event: () => void) => void;
    suspend?: boolean;
  }
  const suspended = new Promise<never>(() => {});
  function EventProbe({ callback, observe, suspend }: EventProbeProps) {
    const event = useCommittedEvent(callback);
    observe(event);
    if (suspend) throw suspended;
    return createElement("button", { onClick: event }, "Invoke");
  }
  function EventBoundary(props: EventProbeProps) {
    return createElement(Suspense, { fallback: "Suspended" }, createElement(EventProbe, props));
  }

  function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
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
      createdAt: 100,
      updatedAt: 100,
      lastReadAt: 100,
      latestAttentionAt: 100,
      ...overrides,
    };
  }

  const wakeAt = Date.now() + 3_600_000;
  function lifecycle(snoozedIds: readonly string[] = []) {
    return {
      shelvesReady: true,
      shelfFor: (row: PluginSidebarThread) => (snoozedIds.includes(row.id) ? "snoozed" : "active"),
      canPark: () => true,
      wakeAtFor: () => wakeAt,
      snooze: mock<LifecycleApi["snooze"]>(() => {}),
      unsnooze: mock<LifecycleApi["unsnooze"]>(() => {}),
    } satisfies LifecycleApi;
  }

  function actions() {
    return {
      open: mock<PluginSidebarThreadActions["open"]>(() => {}),
      archive: mock<PluginSidebarThreadActions["archive"]>(() => {}),
      setPinned: mock<PluginSidebarThreadActions["setPinned"]>(async () => {}),
      requestDelete: mock<PluginSidebarThreadActions["requestDelete"]>(() => {}),
    };
  }

  function hostState(threads: readonly PluginSidebarThread[]): HostState {
    return {
      sidebar: {
        status: "ready",
        threads,
        projects: [
          { id: "one", name: "One", isPersonal: false },
          { id: "two", name: "Two", isPersonal: false },
        ],
      },
      actions: actions(),
      navigate: {},
      lifecycle: lifecycle(),
      settled: { threads: [], ready: true, unsettle: () => {} },
      pullRequests: {},
      splitThreads: [],
      splitEnabled: true,
      onSplitPointerDown: () => {},
    };
  }

  interface InboxProps {
    host: HostState;
    inbox: PluginThreadListProps;
  }

  function Inbox({ host, inbox }: InboxProps) {
    return createElement(HostContext.Provider, { value: host }, createElement(ThreadInbox, inbox));
  }

  function mount(
    host: HostState,
    inbox: Partial<PluginThreadListProps> = {},
    compactThreads = false,
  ) {
    let current: InboxProps = {
      host,
      inbox: {
        activeProjectId: null,
        Original: () => null,
        activeThreadId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        ...inbox,
      },
    };
    const slot = renderSlot({ component: Inbox }, current, { settings: { compactThreads } });
    return {
      slot,
      update(next: Partial<InboxProps>) {
        current = { ...current, ...next };
        slot.lifecycle.rerender(createElement(Inbox, current));
      },
      updateInbox(next: Partial<PluginThreadListProps>) {
        current = { ...current, inbox: { ...current.inbox, ...next } };
        slot.lifecycle.rerender(createElement(Inbox, current));
      },
    };
  }

  function row(slot: RenderedSlot, id: string): HTMLAnchorElement {
    const element = slot.container.querySelector<HTMLAnchorElement>(
      `a[data-sidebar-thread-id="${id}"]`,
    );
    assert.ok(element);
    return element;
  }

  function rowIds(slot: RenderedSlot): string[] {
    return Array.from(
      slot.container.querySelectorAll("[data-sidebar-thread-shortcut-target]"),
      (element) => element.getAttribute("data-sidebar-thread-id")!,
    );
  }

  function rowButton(slot: RenderedSlot, id: string, name: string): HTMLElement {
    return within(row(slot, id).parentElement!).getByRole("button", { name });
  }

  function expandParked(slot: RenderedSlot) {
    fireEvent.click(slot.getByRole("button", { name: "Snoozed (1)" }));
    fireEvent.click(slot.getByRole("button", { name: "Settled (1)" }));
  }

  beforeEach(() => {
    configure({ reactStrictMode: false });
    rowBodyRender.mockClear();
    useActions.mockClear();
  });

  afterEach(() => cleanup());
  afterAll(() => {
    rowBodyRender.mockRestore();
    dom.window.close();
  });

  describe("useCommittedEvent", () => {
    it.each([false, true])(
      "keeps event identity while committing new callbacks with strict mode=%s",
      (reactStrictMode) => {
        configure({ reactStrictMode });
        const first = mock(() => {});
        const second = mock(() => {});
        const observe = mock<EventProbeProps["observe"]>(() => {});
        const slot = renderSlot({ component: EventBoundary }, { callback: first, observe });
        const event = observe.mock.calls.at(-1)![0];
        slot.lifecycle.rerender(createElement(EventBoundary, { callback: second, observe }));
        assert.equal(observe.mock.calls.at(-1)![0], event);
        fireEvent.click(slot.getByRole("button", { name: "Invoke" }));
        assert.equal(first.mock.calls.length, 0);
        assert.equal(second.mock.calls.length, 1);
        cleanup();
        const remounted = renderSlot({ component: EventBoundary }, { callback: first, observe });
        assert.notEqual(observe.mock.calls.at(-1)![0], event);
        fireEvent.click(remounted.getByRole("button", { name: "Invoke" }));
        assert.equal(first.mock.calls.length, 1);
        assert.equal(second.mock.calls.length, 1);
      },
    );

    it("keeps a suspended render's callback out of the committed event", async () => {
      const committed = mock(() => {});
      const speculative = mock(() => {});
      const final = mock(() => {});
      const observe = mock<EventProbeProps["observe"]>(() => {});
      const slot = renderSlot({ component: EventBoundary }, { callback: committed, observe });
      const event = observe.mock.calls.at(-1)![0];
      observe.mockClear();
      await act(async () => {
        startTransition(() => {
          slot.lifecycle.rerender(
            createElement(EventBoundary, { callback: speculative, observe, suspend: true }),
          );
        });
      });
      assert.ok(observe.mock.calls.length > 0);
      assert.equal(observe.mock.calls.at(-1)![0], event);
      fireEvent.click(slot.getByRole("button", { name: "Invoke" }));
      assert.equal(committed.mock.calls.length, 1);
      assert.equal(speculative.mock.calls.length, 0);
      slot.lifecycle.rerender(createElement(EventBoundary, { callback: final, observe }));
      assert.equal(observe.mock.calls.at(-1)![0], event);
      fireEvent.click(slot.getByRole("button", { name: "Invoke" }));
      assert.equal(final.mock.calls.length, 1);
      assert.equal(speculative.mock.calls.length, 0);
    });
  });

  describe("row render isolation", () => {
    it.each([false, true])(
      "only redraws selection changes with compact=%s",
      (isCompactViewport) => {
        const host = hostState([
          thread("pinned", { isPinned: true }),
          thread("a"),
          thread("b"),
          thread("c"),
          thread("waiting", { indicator: "runtime" }),
          thread("snoozed"),
        ]);
        host.lifecycle = lifecycle(["snoozed"]);
        host.settled = {
          ready: true,
          threads: [thread("settled", { isArchived: true })],
          unsettle: () => {},
        };
        const view = mount(host, { activeThreadId: "a", isCompactViewport });
        expandParked(view.slot);
        const order = rowIds(view.slot);
        assert.deepEqual(order, ["pinned", "a", "b", "c", "waiting", "snoozed", "settled"]);
        const retained = order.map((id) => row(view.slot, id));
        rowBodyRender.mockClear();
        useActions.mockClear();
        view.update({ host: { ...host } });
        assert.equal(rowBodyRender.mock.calls.length, 0);
        assert.equal(useActions.mock.calls.length, 1);
        view.updateInbox({ activeThreadId: "b", onNavigate: () => {} });
        assert.equal(rowBodyRender.mock.calls.length, 2);
        assert.deepEqual(rowIds(view.slot), order);
        order.forEach((id, index) => assert.equal(row(view.slot, id), retained[index]));
        rowBodyRender.mockClear();
        view.updateInbox({ activeThreadId: "snoozed" });
        assert.equal(rowBodyRender.mock.calls.length, 2);
        rowBodyRender.mockClear();
        view.updateInbox({ activeThreadId: "settled" });
        assert.equal(rowBodyRender.mock.calls.length, 2);
      },
    );

    it("renders changed title, status, PR and split tint while retaining other rows", () => {
      const a = thread("a");
      const b = thread("b");
      let host = hostState([a, b]);
      const view = mount(host);
      rowBodyRender.mockClear();
      host = {
        ...host,
        sidebar: { ...host.sidebar, threads: [a, { ...b, title: "Renamed", isUnread: true }] },
      };
      view.update({ host });
      assert.equal(rowBodyRender.mock.calls.length, 1);
      assert.equal(row(view.slot, "b").getAttribute("aria-label"), "Renamed");
      assert.ok(row(view.slot, "b").parentElement!.querySelector(".font-medium"));

      rowBodyRender.mockClear();
      host = {
        ...host,
        sidebar: {
          ...host.sidebar,
          threads: [
            a,
            {
              ...host.sidebar.threads[1]!,
              indicator: "unread-error",
              indicatorLabel: "Thread failed",
            },
          ],
        },
      };
      view.update({ host });
      assert.equal(rowBodyRender.mock.calls.length, 1);
      assert.ok(within(row(view.slot, "b").parentElement!).getByLabelText("Thread failed"));

      const pullRequest: PluginSidebarPullRequest = {
        number: 12,
        title: "Row rendering",
        url: "https://example.com/pull/12",
        state: "open",
        attention: "checks_failed",
      };
      rowBodyRender.mockClear();
      host = { ...host, pullRequests: { b: pullRequest } };
      view.update({ host });
      assert.equal(rowBodyRender.mock.calls.length, 1);
      const pr = view.slot.getByRole("link", { name: "#12" });
      assert.equal(pr.getAttribute("href"), pullRequest.url);
      assert.equal(pr.getAttribute("title"), pullRequest.title);
      assert.ok(pr.classList.contains("text-destructive-text"));
      rowBodyRender.mockClear();
      host = { ...host, pullRequests: { b: { ...pullRequest, attention: "ready_to_merge" } } };
      view.update({ host });
      assert.equal(rowBodyRender.mock.calls.length, 1);
      assert.ok(
        view.slot.getByRole("link", { name: "#12" }).classList.contains("text-success-foreground"),
      );

      rowBodyRender.mockClear();
      host = { ...host, splitThreads: ["b"] };
      view.update({ host });
      assert.equal(rowBodyRender.mock.calls.length, 1);
      assert.ok(row(view.slot, "b").parentElement!.classList.contains("bg-sidebar-accent/30"));
      rowBodyRender.mockClear();
      view.update({ host: { ...host, splitThreads: ["b"] } });
      assert.equal(rowBodyRender.mock.calls.length, 0);
    });
  });

  describe("thread hierarchy", () => {
    it.each([false, true])(
      "navigates nested families with desktop compact=%s",
      (compactThreads) => {
        const host = hostState([
          thread("root"),
          thread("child", { parentThreadId: "root" }),
          thread("grandchild", { parentThreadId: "child" }),
          thread("sibling", { parentThreadId: "root" }),
        ]);
        const view = mount(host, {}, compactThreads);
        assert.deepEqual(rowIds(view.slot), ["root", "child", "grandchild", "sibling"]);
        act(() => row(view.slot, "root").focus());
        fireEvent.keyDown(row(view.slot, "root"), { key: "ArrowRight" });
        assert.equal(document.activeElement, row(view.slot, "child"));
        fireEvent.keyDown(row(view.slot, "child"), { key: "ArrowLeft" });
        assert.deepEqual(rowIds(view.slot), ["root", "child", "sibling"]);
        assert.equal(document.activeElement, row(view.slot, "child"));
        fireEvent.keyDown(row(view.slot, "child"), { key: "ArrowLeft" });
        assert.equal(document.activeElement, row(view.slot, "root"));
        fireEvent.keyDown(row(view.slot, "root"), { key: "ArrowLeft" });
        assert.deepEqual(rowIds(view.slot), ["root"]);
        fireEvent.keyDown(row(view.slot, "root"), { key: "ArrowRight" });
        assert.deepEqual(rowIds(view.slot), ["root", "child", "sibling"]);
        fireEvent.click(rowButton(view.slot, "child", "Expand children of child"));
        assert.deepEqual(rowIds(view.slot), ["root", "child", "grandchild", "sibling"]);
        assert.equal(
          (host.actions.open as ReturnType<typeof actions>["open"]).mock.calls.length,
          0,
        );
      },
    );

    it.each([false, true])(
      "shows child project changes with desktop compact=%s",
      (compactThreads) => {
        const host = hostState([
          thread("root"),
          thread("child", { parentThreadId: "root" }),
          thread("cross-project", { parentThreadId: "root", projectId: "two" }),
        ]);
        const view = mount(host, {}, compactThreads);
        const root = row(view.slot, "root").parentElement!;
        const child = row(view.slot, "child").parentElement!;
        const crossProject = row(view.slot, "cross-project").parentElement!;
        assert.equal(root.classList.contains("gtd-compact-row"), compactThreads);
        assert.ok(child.classList.contains("gtd-compact-row"));
        assert.ok(crossProject.classList.contains("gtd-compact-row"));
        assert.equal(child.querySelector(".gtd-project-chip"), null);
        assert.equal(crossProject.querySelector(".gtd-project-chip")?.textContent, "Two");
        fireEvent.click(row(view.slot, "cross-project"), { ctrlKey: true });
        assert.deepEqual((host.actions.open as ReturnType<typeof actions>["open"]).mock.calls, [
          ["cross-project", { split: true }],
        ]);
      },
    );

    it("opens compact thread details from the keyboard navigation anchor", async () => {
      const view = mount(
        hostState([thread("root"), thread("child", { parentThreadId: "root" })]),
        {},
        true,
      );
      fireEvent.focus(row(view.slot, "child"));
      const tooltip = await screen.findByRole("tooltip");
      assert.match(tooltip.textContent ?? "", /child/);
      assert.match(tooltip.textContent ?? "", /One/);
      assert.match(tooltip.textContent ?? "", /Child of root/);
      assert.match(tooltip.textContent ?? "", /codex/);
      fireEvent.blur(row(view.slot, "child"));
    });

    it("reveals a matching descendant through a collapsed family without changing collapse state", () => {
      const view = mount(
        hostState([
          thread("root"),
          thread("child", { parentThreadId: "root" }),
          thread("needle", { parentThreadId: "child" }),
          thread("unrelated"),
        ]),
      );
      fireEvent.click(rowButton(view.slot, "root", "Collapse children of root"));
      assert.deepEqual(rowIds(view.slot), ["root", "unrelated"]);
      view.updateInbox({ searchQuery: "needle" });
      assert.deepEqual(rowIds(view.slot), ["root", "child", "needle"]);
      view.updateInbox({ searchQuery: "" });
      assert.deepEqual(rowIds(view.slot), ["root", "unrelated"]);
    });

    it("settles a waiting child on Next Action and advances only through visible rows", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("root", { latestAttentionAt: 200 }),
          thread("child", { parentThreadId: "root", indicator: "runtime" }),
          thread("grandchild", { parentThreadId: "child" }),
          thread("next"),
        ]),
        actions: currentActions,
      };
      const view = mount(host, { activeThreadId: "child" }, true);
      fireEvent.click(rowButton(view.slot, "child", "Collapse children of child"));
      assert.deepEqual(rowIds(view.slot), ["root", "child", "next"]);
      const section = row(view.slot, "child").closest("section");
      assert.equal(section?.getAttribute("aria-label"), "Next Action");
      assert.ok(rowButton(view.slot, "child", "Snooze"));
      fireEvent.pointerDown(rowButton(view.slot, "child", "Settle"));
      assert.deepEqual(currentActions.archive.mock.calls, [["child"]]);
      assert.deepEqual(currentActions.open.mock.calls, [["next"]]);
    });
  });

  describe("waiting shelf", () => {
    it("folds its rows away and keeps the rest of the list in place", () => {
      const host = hostState([
        thread("a"),
        thread("waiting", { indicator: "runtime" }),
        thread("also-waiting", { indicator: "runtime" }),
      ]);
      const view = mount(host);
      assert.deepEqual(rowIds(view.slot), ["a", "also-waiting", "waiting"]);
      fireEvent.click(view.slot.getByRole("button", { name: "Waiting" }));
      assert.deepEqual(rowIds(view.slot), ["a"]);
      fireEvent.click(view.slot.getByRole("button", { name: "Waiting (2)" }));
      assert.deepEqual(rowIds(view.slot), ["a", "also-waiting", "waiting"]);
    });
  });

  describe("committed row commands", () => {
    it("opens and drags with current host callbacks without redrawing an unchanged row", () => {
      const previousActions = actions();
      const previousNavigate = mock(() => {});
      const previousPointer = mock<HostState["onSplitPointerDown"]>(() => {});
      const host = {
        ...hostState([thread("a")]),
        actions: previousActions,
        onSplitPointerDown: previousPointer,
      };
      const view = mount(host, { onNavigate: previousNavigate });
      const currentActions = actions();
      const currentNavigate = mock(() => {});
      const currentPointer = mock<HostState["onSplitPointerDown"]>(() => {});
      rowBodyRender.mockClear();
      view.update({
        host: { ...host, actions: currentActions, onSplitPointerDown: currentPointer },
      });
      view.updateInbox({ onNavigate: currentNavigate });
      assert.equal(rowBodyRender.mock.calls.length, 0);
      fireEvent.pointerDown(row(view.slot, "a"));
      fireEvent.click(row(view.slot, "a"), { metaKey: true });
      assert.deepEqual(currentActions.open.mock.calls, [["a", { split: true }]]);
      assert.equal(currentNavigate.mock.calls.length, 1);
      assert.equal(currentPointer.mock.calls[0]?.[0], "a");
      assert.equal(previousActions.open.mock.calls.length, 0);
      assert.equal(previousNavigate.mock.calls.length, 0);
      assert.equal(previousPointer.mock.calls.length, 0);
      fireEvent.click(row(view.slot, "a"), { button: 2 });
      assert.equal(currentActions.open.mock.calls.length, 1);
      view.update({ host: { ...host, splitEnabled: false, onSplitPointerDown: currentPointer } });
      fireEvent.pointerDown(row(view.slot, "a"));
      assert.equal(currentPointer.mock.calls.length, 1);
    });

    it("settles against the current selection and scoped shelf, then repairs the compose route", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("pinned", { isPinned: true }),
          thread("a", { latestAttentionAt: 30 }),
          thread("b", { projectId: "two", latestAttentionAt: 20 }),
          thread("c", { latestAttentionAt: 10 }),
          thread("waiting", { indicator: "runtime" }),
        ]),
        actions: currentActions,
      };
      const oldNavigate = mock(() => {});
      const navigate = mock(() => {});
      const view = mount(host, { activeThreadId: "c", onNavigate: oldNavigate });
      view.updateInbox({ activeThreadId: "a", onNavigate: navigate });
      fireEvent.keyDown(view.slot.getByRole("combobox"), { key: "ArrowDown" });
      fireEvent.click(screen.getByRole("option", { name: "One" }));
      assert.deepEqual(rowIds(view.slot), ["pinned", "a", "c", "waiting"]);
      fireEvent.pointerDown(rowButton(view.slot, "c", "Settle"));
      assert.equal(currentActions.open.mock.calls.length, 0);
      fireEvent.pointerDown(rowButton(view.slot, "a", "Settle"));
      assert.deepEqual(currentActions.open.mock.calls, [["c"]]);
      assert.deepEqual(currentActions.archive.mock.calls, [["c"], ["a"]]);
      assert.ok(
        currentActions.open.mock.invocationCallOrder[0]! <
          currentActions.archive.mock.invocationCallOrder[1]!,
      );
      assert.equal(navigate.mock.calls.length, 1);
      assert.equal(oldNavigate.mock.calls.length, 0);
      view.updateInbox({ activeThreadId: null });
      assert.deepEqual(currentActions.open.mock.calls, [["c"], ["c"]]);
      assert.equal(navigate.mock.calls.length, 1);
    });

    it("settles against reordered rows while the selected row remains memoized", () => {
      const a = thread("a", { latestAttentionAt: 30 });
      const b = thread("b", { latestAttentionAt: 20 });
      const c = thread("c", { latestAttentionAt: 10 });
      const currentActions = actions();
      const host = { ...hostState([a, b, c]), actions: currentActions };
      const view = mount(host, { activeThreadId: "a" });
      rowBodyRender.mockClear();
      view.update({
        host: {
          ...host,
          sidebar: { ...host.sidebar, threads: [a, { ...b, latestAttentionAt: 40 }, c] },
        },
      });
      assert.equal(rowBodyRender.mock.calls.length, 1);
      assert.deepEqual(rowIds(view.slot), ["b", "a", "c"]);
      fireEvent.pointerDown(rowButton(view.slot, "a", "Settle"));
      assert.deepEqual(currentActions.open.mock.calls, [["c"]]);
    });

    it("uses current lifecycle actions and general navigation for settled mobile rows", () => {
      const oldLifecycle = lifecycle(["snoozed"]);
      const oldRestore = mock<SettledThreadsApi["unsettle"]>(() => {});
      const host = {
        ...hostState([thread("active"), thread("snoozed")]),
        lifecycle: oldLifecycle,
        settled: {
          ready: true,
          threads: [thread("settled", { isArchived: true })],
          unsettle: oldRestore,
        },
      };
      const oldNavigate = mock(() => {});
      const view = mount(host, { isCompactViewport: true, onNavigate: oldNavigate });
      expandParked(view.slot);
      const currentLifecycle = lifecycle(["snoozed"]);
      const currentRestore = mock<SettledThreadsApi["unsettle"]>(() => {});
      const currentActions = actions();
      const toThread = mock<BbNavigate["toThread"]>(() => {});
      const onNavigate = mock(() => {});
      rowBodyRender.mockClear();
      view.update({
        host: {
          ...host,
          lifecycle: currentLifecycle,
          actions: currentActions,
          navigate: { toThread },
          settled: { ...host.settled, unsettle: currentRestore },
        },
      });
      view.updateInbox({ onNavigate });
      assert.equal(rowBodyRender.mock.calls.length, 0);
      fireEvent.click(row(view.slot, "settled"), { ctrlKey: true });
      assert.deepEqual(toThread.mock.calls, [["settled"]]);
      assert.equal(currentActions.open.mock.calls.length, 0);
      assert.equal(onNavigate.mock.calls.length, 1);
      fireEvent.click(row(view.slot, "snoozed"));
      assert.deepEqual(currentActions.open.mock.calls, [["snoozed", { split: false }]]);
      assert.equal(onNavigate.mock.calls.length, 2);
      fireEvent.click(rowButton(view.slot, "snoozed", "Wake now"));
      fireEvent.click(rowButton(view.slot, "settled", "Un-settle"));
      assert.deepEqual(currentLifecycle.unsnooze.mock.calls, [["snoozed"]]);
      assert.deepEqual(currentRestore.mock.calls, [["settled"]]);
      assert.equal(oldLifecycle.unsnooze.mock.calls.length, 0);
      assert.equal(oldRestore.mock.calls.length, 0);
      assert.equal(oldNavigate.mock.calls.length, 0);
    });

    it("routes snooze, pin and delete through the current dispatcher", async () => {
      const oldLifecycle = lifecycle();
      const oldActions = actions();
      const host = { ...hostState([thread("a")]), lifecycle: oldLifecycle, actions: oldActions };
      const view = mount(host);
      const currentLifecycle = lifecycle();
      const currentActions = actions();
      view.update({ host: { ...host, lifecycle: currentLifecycle, actions: currentActions } });
      fireEvent.pointerDown(rowButton(view.slot, "a", "Snooze"));
      assert.equal(currentLifecycle.snooze.mock.calls[0]?.[0], "a");
      assert.ok(currentLifecycle.snooze.mock.calls[0]![1] > Date.now());
      fireEvent.contextMenu(row(view.slot, "a"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
      await act(async () => {});
      assert.deepEqual(currentActions.setPinned.mock.calls, [["a", true]]);
      fireEvent.contextMenu(row(view.slot, "a"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      assert.deepEqual(currentActions.requestDelete.mock.calls, [["a"]]);
      assert.equal(oldLifecycle.snooze.mock.calls.length, 0);
      assert.equal(oldActions.setPinned.mock.calls.length, 0);
      assert.equal(oldActions.requestDelete.mock.calls.length, 0);
    });
  });
}
