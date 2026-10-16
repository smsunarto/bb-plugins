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
  }, 60_000);
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
  // jsdom only paints frames when it pretends to be visual; the rename
  // editor focuses on the next one.
  globalThis.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(performance.now()), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom lays nothing out. The list window reads its viewport from the
  // scroll container's offsetHeight and each mounted row's height from its
  // bounding box. By default the viewport is tall and rows are 0px, so every
  // row mounts; the windowing tests shrink the viewport and give rows height.
  const layout = { viewport: 10_000, rowHeight: 0 };
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("overflow-y-auto") ? layout.viewport : 0;
    },
  });
  const jsdomRect = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    if (layout.rowHeight === 0 || !this.hasAttribute("data-gtd-row")) return jsdomRect.call(this);
    const height = layout.rowHeight;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: 240,
      height,
      right: 240,
      bottom: height,
    } as DOMRect;
  };
  const { act, cleanup, configure, fireEvent, screen, waitFor, within } =
    await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createContext, createElement, startTransition, Suspense, useContext, useMemo } =
    await import("react");
  const sdk = { ...(await import("@get-bb/plugin-sdk/app")) };

  interface HostState {
    naming?: ReadonlySet<string>;
    /** bb's primary host. Unset leaves the read unanswered, as at startup. */
    primaryHostId?: string | null;
    sidebar: PluginSidebarThreadsState;
    actions: Partial<PluginSidebarThreadActions>;
    navigate: Partial<BbNavigate>;
    lifecycle: LifecycleApi;
    unarchive: (args: { threadId: string }) => Promise<{ ok: true }>;
    pullRequests: Readonly<Record<string, PluginSidebarPullRequest>>;
    splitThreads: readonly string[];
    focusedSplitThread?: string;
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
    // bb's client is stable for the plugin's lifetime; effects keyed on it
    // must not refire on every render here either.
    useSdk: () => {
      const { unarchive, primaryHostId } = useHost();
      return useMemo(
        () => ({
          threads: { unarchive, list: async () => [] },
          subscribe: () => () => {},
          system: {
            config: () =>
              primaryHostId === undefined
                ? new Promise<never>(() => {})
                : Promise.resolve({ primaryHostId }),
          },
        }),
        [unarchive, primaryHostId],
      );
    },
    experimental_useSidebarThreadActions: useActions,
    useBbNavigate: () => ({ ...sdk.useBbNavigate(), ...useHost().navigate }),
    experimental_useSidebarThreadSplit: (threadId: string) => {
      const host = useHost();
      return {
        isAvailable: host.splitEnabled,
        layout: host.splitThreads.includes(threadId)
          ? {
              panes: host.splitThreads.map((id) => ({
                paneId: id,
                rect: { x: 0, y: 0, width: 1, height: 1 },
                isMe: id === threadId,
                isFocused: id === host.focusedSplitThread,
              })),
            }
          : null,
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
  mock.module("../hooks/use-naming-threads.ts", () => ({
    useNamingThreads: () => useHost().naming ?? new Set(),
  }));
  const rowBodyRender = spyOn(
    await import("../components/inbox/row-context-menu.tsx"),
    "RowContextMenu",
  );
  const { ThreadInbox } = await import("../components/inbox/thread-inbox.tsx");
  const { useCommittedEvent } = await import("../hooks/use-committed-event.ts");
  const { settleThread } = await import("../lib/sidebar-actions-bridge.ts");
  const { TOUCH_PRESS_FEEDBACK_MS } = await import("../hooks/use-ios-long-press.ts");

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
      displayTitle: overrides.title ?? id,
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
      ...overrides,
    };
  }

  // Settled a minute ago: inside the shelf's window on the inbox's own clock.
  function settledThread(id: string) {
    return thread(id, { isArchived: true, archivedAt: Date.now() - 60_000 });
  }

  const wakeAt = Date.now() + 3_600_000;
  function lifecycle(snoozedIds: readonly string[] = []) {
    return {
      shelvesReady: true,
      shelfFor: (row: PluginSidebarThread) => (snoozedIds.includes(row.id) ? "snoozed" : "active"),
      canPark: () => true,
      wakeAtFor: () => wakeAt,
      snoozedAtFor: (row: PluginSidebarThread) =>
        snoozedIds.includes(row.id) ? wakeAt - 3_600_000 : null,
      snooze: mock<LifecycleApi["snooze"]>(() => {}),
      unsnooze: mock<LifecycleApi["unsnooze"]>(() => {}),
    } satisfies LifecycleApi;
  }

  function actions() {
    return {
      open: mock<PluginSidebarThreadActions["open"]>(() => {}),
      openNewThread: mock<PluginSidebarThreadActions["openNewThread"]>(() => {}),
      archive: mock<PluginSidebarThreadActions["archive"]>(() => {}),
      setPinned: mock<PluginSidebarThreadActions["setPinned"]>(async () => {}),
      setRead: mock<PluginSidebarThreadActions["setRead"]>(async () => {}),
      rename: mock<PluginSidebarThreadActions["rename"]>(async () => {}),
      requestDelete: mock<PluginSidebarThreadActions["requestDelete"]>(() => {}),
    };
  }

  function hostState(threads: readonly PluginSidebarThread[]): HostState {
    return {
      sidebar: {
        status: "ready",
        threads,
        experimental_archived: null,
        sections: [],
        projects: [
          { id: "one", name: "One", isPersonal: false, href: "", settingsHref: "" },
          { id: "two", name: "Two", isPersonal: false, href: "", settingsHref: "" },
        ],
      },
      actions: actions(),
      navigate: {},
      lifecycle: lifecycle(),
      unarchive: async () => ({ ok: true }),
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
    localMachineId = "",
    options: NonNullable<Parameters<typeof renderSlot>[2]> = {},
  ) {
    let current: InboxProps = {
      host,
      inbox: {
        activeProjectId: null,
        activeThreadId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
        ...inbox,
      },
    };
    const settings = {
      compactThreads,
      localMachineId,
      groupThreadsByProject: true,
      ...options.settings,
    };
    const slot = renderSlot({ component: Inbox }, current, { ...options, settings });
    return {
      slot,
      setGrouping(enabled: boolean) {
        settings.groupThreadsByProject = enabled;
        slot.lifecycle.rerender(createElement(Inbox, current));
      },
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

  /**
   * A row link's description as a screen reader hears it: each element its
   * aria-describedby names, with a labelled glyph read by its label. Testing
   * Library's own `description` match skips aria-label inside a description,
   * which browsers read.
   */
  function description(slot: RenderedSlot, id: string): string {
    return row(slot, id)
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((ref) => {
        const part = document.getElementById(ref)!;
        const glyphs = within(part)
          .queryAllByRole("img")
          .map((img) => img.getAttribute("aria-label"));
        return [...glyphs, part.textContent].filter(Boolean).join(" ");
      })
      .join(" ");
  }

  async function openMenu(anchor: HTMLAnchorElement, compact: boolean) {
    if (compact) {
      fireEvent.mouseDown(anchor, { button: 0 });
      await screen.findByRole("menu", { name: "Thread actions" });
      fireEvent.mouseUp(anchor, { button: 0 });
    } else {
      fireEvent.contextMenu(anchor);
    }
  }

  async function holdInRenameInput(input: HTMLElement, draft: string) {
    fireEvent.touchStart(input, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.mouseDown(input, { button: 0 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    fireEvent.touchEnd(input);
    fireEvent.mouseUp(input);
    assert.equal(screen.queryByRole("menu"), null);
    assert.equal(screen.getAllByRole("textbox", { name: "Thread name" }).length, 1);
    assert.equal((input as HTMLInputElement).value, draft);
    assert.equal(document.activeElement, input);
  }

  /** Holds a touch past the tap delay, when a resting finger tints its row. */
  async function restPastTapDelay() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TOUCH_PRESS_FEEDBACK_MS + 20));
    });
  }

  function rowIds(slot: RenderedSlot): string[] {
    return Array.from(
      slot.container.querySelectorAll("[data-sidebar-thread-shortcut-target]"),
      (element) => element.getAttribute("data-sidebar-thread-id")!,
    );
  }

  /** jsdom lays nothing out, so a row's title is clipped by giving it widths. */
  function clipTitle(slot: RenderedSlot, id: string) {
    const title = row(slot, id).parentElement!.querySelector<HTMLElement>(
      ".gtd-thread-title .gtd-fading-text",
    )!;
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 200 });
    Object.defineProperty(title, "clientWidth", { configurable: true, value: 100 });
  }

  function rowButton(slot: RenderedSlot, id: string, name: string): HTMLElement {
    return within(row(slot, id).parentElement!).getByRole("button", { name });
  }

  function expandParked(slot: RenderedSlot) {
    fireEvent.click(slot.getByRole("button", { name: "Snoozed (1)" }));
    fireEvent.click(slot.getByRole("button", { name: "Settled (1)" }));
  }

  beforeEach(() => {
    layout.viewport = 10_000;
    layout.rowHeight = 0;
    configure({ reactStrictMode: false });
    localStorage.clear();
    rowBodyRender.mockClear();
    useActions.mockClear();
  });

  afterEach(() => cleanup());
  afterAll(() => {
    rowBodyRender.mockRestore();
    dom.window.close();
  });

  describe("unread activity in the status slot", () => {
    it.each([
      { mobile: false, compact: false },
      { mobile: false, compact: true },
      { mobile: true, compact: false },
    ])("shows unread dots on every shelf with %j and clears on read", ({ mobile, compact }) => {
      const unread = { isUnread: true, indicator: "unread-success" as const };
      const threads = [
        thread("finished", unread),
        thread("snoozed", unread),
        { ...settledThread("settled"), ...unread },
        thread("working", { isUnread: true, indicator: "runtime", indicatorLabel: "Working" }),
      ];
      const host = { ...hostState(threads), lifecycle: lifecycle(["snoozed"]) };
      const view = mount(host, { isCompactViewport: mobile }, compact);
      expandParked(view.slot);
      for (const id of ["finished", "snoozed", "settled"]) {
        const container = row(view.slot, id).parentElement!;
        const dot = within(container).getByRole("img", { name: "Unread response" });
        assert.ok(dot.closest(".w-7"));
        // Said once: the slot's dot is the whole description.
        assert.equal(description(view.slot, id), "Unread response");
      }
      assert.ok(within(row(view.slot, "working").parentElement!).getByLabelText("Working"));
      // The glyph takes the slot, so the note follows it.
      assert.equal(description(view.slot, "working"), "Working Unread response");
      assert.equal(
        within(row(view.slot, "working").parentElement!).queryByRole("img", {
          name: "Unread response",
        }),
        null,
      );
      view.update({
        host: {
          ...host,
          sidebar: {
            ...host.sidebar,
            threads: threads.map((entry) => Object.assign({}, entry, { isUnread: false })),
          },
        },
      });
      assert.equal(view.slot.queryAllByRole("img", { name: "Unread response" }).length, 0);
      assert.ok(within(row(view.slot, "working").parentElement!).getByLabelText("Working"));
    });

    it("lifts age labels to the readback tint on a phone, keeping desktop's ghost tint", () => {
      // An hour clear of the bucket edge: the age reads a minute-quantized clock.
      const threeDaysAgo = Date.now() - 3 * 86_400_000 - 3_600_000;
      const threads = [
        thread("card", { latestAttentionAt: threeDaysAgo }),
        { ...settledThread("parked"), latestAttentionAt: threeDaysAgo },
      ];
      const tints = (isCompactViewport: boolean) => {
        const view = mount(hostState(threads), { isCompactViewport });
        fireEvent.click(view.slot.getByRole("button", { name: "Settled (1)" }));
        const result = ["card", "parked"].map((id) => {
          const age = within(row(view.slot, id).parentElement!).getByText("3d");
          return ["text-readback-foreground", "text-muted-foreground/40"].filter((name) =>
            age.classList.contains(name),
          );
        });
        cleanup();
        return result;
      };
      assert.deepEqual(
        [tints(true), tints(false)],
        [
          [["text-readback-foreground"], ["text-readback-foreground"]],
          [["text-muted-foreground/40"], ["text-muted-foreground/40"]],
        ],
      );
    });

    it("keeps the collapsed family's unread dot in the status slot", () => {
      const root = thread("root");
      const child = thread("child", {
        parentThreadId: "root",
        isUnread: true,
        indicator: "unread-success",
      });
      const view = mount(hostState([root, child]));
      fireEvent.click(rowButton(view.slot, "root", "Collapse children of root"));
      const container = row(view.slot, "root").parentElement!;
      assert.ok(within(container).getByRole("img", { name: "Unread response" }).closest(".w-7"));
      // The note stands in for the dot: it also says where the unread work is.
      assert.equal(description(view.slot, "root"), "Unread response in subthreads");
      fireEvent.click(rowButton(view.slot, "root", "Expand children of root"));
      assert.equal(within(container).queryByRole("img", { name: "Unread response" }), null);
      assert.ok(
        within(row(view.slot, "child").parentElement!).getByRole("img", {
          name: "Unread response",
        }),
      );
    });
  });

  describe("row descriptions", () => {
    it.each([false, true])(
      "describe each row by its status, age or wake time, mobile=%s",
      (isCompactViewport) => {
        // An hour clear of each label's bucket edge, on a minute-quantized clock.
        const threeDaysAgo = Date.now() - 3 * 86_400_000 - 3_600_000;
        const host = hostState([
          thread("asks", {
            hasPendingInteraction: true,
            indicator: "waiting-for-input",
            indicatorLabel: "Needs input",
          }),
          thread("quiet", { latestAttentionAt: threeDaysAgo }),
          thread("snoozed"),
          { ...settledThread("settled"), latestAttentionAt: threeDaysAgo },
        ]);
        host.lifecycle = {
          ...lifecycle(["snoozed"]),
          wakeAtFor: () => Date.now() + 3 * 86_400_000 + 3_600_000,
        };
        const view = mount(host, { activeThreadId: "snoozed", isCompactViewport });
        expandParked(view.slot);
        // The snoozed row says its wake time, not the "Wake now" button beside it.
        assert.deepEqual(
          ["asks", "quiet", "snoozed", "settled"].map((id) => description(view.slot, id)),
          ["Needs input", "3d", "4d", "3d"],
        );
        assert.deepEqual(
          ["snoozed", "settled", "asks"].map((id) =>
            row(view.slot, id).getAttribute("aria-current"),
          ),
          ["page", null, null],
        );
      },
    );
  });

  describe("desktop right-click menus", () => {
    it("open from Shift+F10 or the Menu key on rows and project headers", async () => {
      const host = hostState([
        thread("a"),
        thread("b", { projectId: "two" }),
        settledThread("settled"),
      ]);
      const view = mount(host);
      fireEvent.click(view.slot.getByRole("button", { name: "Settled (1)" }));
      fireEvent.click(view.slot.getByRole("button", { name: "One project, 1 thread" }));
      const card = row(view.slot, "a");
      act(() => card.focus());
      // A bare F10 is not the shortcut.
      fireEvent.keyDown(card, { key: "F10" });
      assert.equal(screen.queryByRole("menu"), null);
      fireEvent.keyDown(card, { key: "F10", shiftKey: true });
      const menu = screen.getByRole("menu", { name: "Thread actions" });
      assert.ok(within(menu).getByRole("menuitem", { name: "Rename" }));
      fireEvent.keyDown(menu, { key: "Escape" });
      // An identity check: a failing deep-equal on DOM nodes walks their React
      // internals, which stalls waitFor past the test timeout.
      await waitFor(() => assert.ok(document.activeElement === card, "focus returns to the card"));

      fireEvent.keyDown(row(view.slot, "settled"), { key: "ContextMenu" });
      assert.ok(screen.getByRole("menuitem", { name: "Un-settle" }));
      fireEvent.keyDown(screen.getByRole("menu", { name: "Thread actions" }), { key: "Escape" });
      await waitFor(() => assert.equal(screen.queryByRole("menu"), null));

      fireEvent.keyDown(view.slot.getAllByRole("button", { name: "One project" })[0]!, {
        key: "ContextMenu",
      });
      const projectMenu = screen.getByRole("menu", { name: "One project actions" });
      assert.deepEqual(
        within(projectMenu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
        ["Move down"],
      );
    });

    it("leave Shift+F10 to a live keyboard drag", () => {
      const view = mount(hostState([thread("a"), thread("b")]));
      const card = row(view.slot, "a");
      act(() => card.focus());
      fireEvent.keyDown(card, { key: " ", code: "Space" });
      assert.equal(card.closest("[data-dragging]")?.getAttribute("data-dragging"), "true");
      fireEvent.keyDown(card, { key: "F10", shiftKey: true });
      assert.equal(screen.queryByRole("menu"), null);
      fireEvent.keyDown(card, { key: "Escape", code: "Escape" });
    });

    it("draw the project menu on the thread menu's surface", () => {
      const view = mount(hostState([thread("a"), thread("b", { projectId: "two" })]));
      const surface = (open: () => void, name: string) => {
        open();
        const menu = screen.getByRole("menu", { name });
        const result = [menu.style.background, menu.firstElementChild?.className];
        fireEvent.keyDown(menu, { key: "Escape" });
        return result;
      };
      const thread_ = surface(() => fireEvent.contextMenu(row(view.slot, "a")), "Thread actions");
      const project = surface(
        () => fireEvent.contextMenu(view.slot.getByRole("button", { name: "Two project" })),
        "Two project actions",
      );
      assert.deepEqual(project, thread_);
      // The theme's opaque card gives way to the blurred layer inside it.
      assert.equal(thread_[0], "transparent");
      assert.match(thread_[1] ?? "", /inset_0_0_0_1px_var\(--border\)/);
    });
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
      "marks only naming titles busy, including parked rows, with mobile=%s",
      (isCompactViewport) => {
        const host = hostState([thread("a"), thread("b"), thread("snoozed")]);
        host.lifecycle = lifecycle(["snoozed"]);
        host.naming = new Set(["a", "snoozed"]);
        const view = mount(host, { isCompactViewport });
        fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (1)" }));
        for (const id of ["a", "snoozed"]) {
          assert.equal(
            row(view.slot, id)
              .parentElement!.querySelector('[data-gtd-naming="true"]')
              ?.getAttribute("aria-busy"),
            "true",
          );
        }
        assert.equal(row(view.slot, "b").parentElement!.querySelector("[data-gtd-naming]"), null);
        view.update({ host: { ...host, naming: new Set() } });
        assert.equal(view.slot.container.querySelector("[data-gtd-naming]"), null);
      },
    );

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
          settledThread("settled"),
        ]);
        host.lifecycle = lifecycle(["snoozed"]);
        const view = mount(host, { activeThreadId: "a", isCompactViewport });
        assert.ok(view.slot.container.querySelector("[data-gtd-sidebar-thread-list]"));
        assert.equal(row(view.slot, "a").parentElement!.dataset.sidebarThreadActive, "true");
        assert.equal(row(view.slot, "b").parentElement!.dataset.sidebarThreadActive, undefined);
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
        assert.equal(row(view.slot, "a").parentElement!.dataset.sidebarThreadActive, undefined);
        assert.equal(row(view.slot, "b").parentElement!.dataset.sidebarThreadActive, "true");
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

    it.each([false, true])(
      "gives only the open thread the selected fill, pressed or not, compact=%s",
      async (isCompactViewport) => {
        const host = hostState([thread("a"), thread("b"), thread("snoozed")]);
        host.lifecycle = lifecycle(["snoozed"]);
        const view = mount(host, { activeThreadId: "a", isCompactViewport });
        fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (1)" }));
        const card = (id: string) => row(view.slot, id).parentElement!;
        const fills = () =>
          ["a", "b", "snoozed"].map((id) =>
            ["bg-state-active", "bg-sidebar-accent", "hover:bg-sidebar-accent"].filter((name) =>
              card(id).classList.contains(name),
            ),
          );
        // A touch press tints a resting row and leaves the open one selected.
        const press = async (ids: readonly string[], pressed: string[][]) => {
          if (!isCompactViewport) return;
          for (const id of ids) {
            fireEvent.touchStart(card(id), { touches: [{ clientX: 0, clientY: 0 }] });
          }
          await restPastTapDelay();
          assert.deepEqual(fills(), pressed);
          for (const id of ids) fireEvent.touchEnd(card(id));
        };
        const active = ["bg-state-active"];
        const rest = ["hover:bg-sidebar-accent"];
        const pressedRest = ["bg-sidebar-accent", ...rest];
        assert.deepEqual(fills(), [active, rest, rest]);
        await press(["a", "snoozed"], [active, rest, pressedRest]);
        view.updateInbox({ activeThreadId: "snoozed" });
        assert.deepEqual(fills(), [rest, rest, active]);
        await press(["b", "snoozed"], [rest, pressedRest, active]);
        assert.deepEqual(fills(), [rest, rest, active]);
      },
    );

    it("tints a touched row only once the finger rests, never on a scroll flick", async () => {
      const host = hostState([thread("card"), thread("snoozed")]);
      host.lifecycle = lifecycle(["snoozed"]);
      const view = mount(host, { isCompactViewport: true });
      fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (1)" }));
      const tinted = () =>
        ["card", "snoozed"].map((id) =>
          row(view.slot, id).parentElement!.classList.contains("bg-sidebar-accent"),
        );
      for (const id of ["card", "snoozed"]) {
        const target = row(view.slot, id).parentElement!;
        fireEvent.touchStart(target, { touches: [{ clientX: 0, clientY: 0 }] });
        fireEvent.touchMove(target, { touches: [{ clientX: 0, clientY: -30 }] });
      }
      await restPastTapDelay();
      assert.deepEqual(tinted(), [false, false]);
      for (const id of ["card", "snoozed"]) fireEvent.touchEnd(row(view.slot, id).parentElement!);

      for (const id of ["card", "snoozed"]) {
        const target = row(view.slot, id).parentElement!;
        fireEvent.touchStart(target, { touches: [{ clientX: 0, clientY: 0 }] });
      }
      assert.deepEqual(tinted(), [false, false]);
      await restPastTapDelay();
      assert.deepEqual(tinted(), [true, true]);
      for (const id of ["card", "snoozed"]) fireEvent.touchEnd(row(view.slot, id).parentElement!);
      assert.deepEqual(tinted(), [false, false]);
    });

    it("keeps the hold's no-select style beside a touch row's own padding", () => {
      const host = hostState([thread("card"), thread("snoozed")]);
      host.lifecycle = lifecycle(["snoozed"]);
      const view = mount(host, { isCompactViewport: true });
      fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (1)" }));
      // jsdom drops -webkit-touch-callout; user-select rides the same object.
      assert.deepEqual(
        ["card", "snoozed"].map((id) => {
          const { style } = row(view.slot, id).parentElement!;
          return [style.userSelect, style.paddingLeft];
        }),
        [
          ["none", "calc(22px + var(--gtd-leaf-group-indent, 0px))"],
          ["none", "calc(22px + var(--gtd-leaf-group-indent, 0px))"],
        ],
      );
    });

    it("lifts the row's own line: its padding, chevron and restore glyph", async () => {
      const host = hostState([
        thread("root"),
        thread("child", { parentThreadId: "root" }),
        thread("sleeper"),
      ]);
      host.lifecycle = lifecycle(["sleeper"]);
      const view = mount(host, { isCompactViewport: true });
      fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (1)" }));
      const lifted = async (id: string) => {
        await openMenu(row(view.slot, id), true);
        const copy = document.body.querySelector('[data-state="open"].fixed.z-50');
        assert.ok(copy);
        const content = copy.firstElementChild as HTMLElement;
        const icons = Array.from(content.querySelectorAll("[data-icon]"), (icon) =>
          icon.getAttribute("data-icon"),
        );
        fireEvent.keyDown(screen.getByRole("menu", { name: "Thread actions" }), {
          key: "Escape",
        });
        await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
        return [content.style.paddingLeft, icons];
      };
      assert.deepEqual(
        [await lifted("root"), await lifted("child"), await lifted("sleeper")],
        [
          ["calc(40px + var(--gtd-group-indent, 0px))", ["ChevronDown"]],
          ["calc(56px + var(--gtd-group-indent, 0px))", []],
          ["calc(22px + var(--gtd-leaf-group-indent, 0px))", ["AlarmClock"]],
        ],
      );
    });

    it("lifts a row into the touch menu with the fill it had, selected or pressed", async () => {
      const host = hostState([thread("a"), thread("b"), thread("snoozed")]);
      host.lifecycle = lifecycle(["snoozed"]);
      const view = mount(host, { activeThreadId: "a", isCompactViewport: true });
      const ACTIVE_LIFT =
        "linear-gradient(var(--state-active), var(--state-active)), var(--sidebar)";
      const RESTING_LIFT =
        "linear-gradient(var(--sidebar-accent), var(--sidebar-accent)), var(--sidebar)";
      fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (1)" }));
      const lifted = async (id: string) => {
        await openMenu(row(view.slot, id), true);
        const copy = document.body.querySelector('[data-state="open"].fixed.z-50');
        assert.ok(copy);
        // The fill, laid over the opaque sidebar so the scrim can't shade it.
        const fill = (copy as HTMLElement).style.background;
        fireEvent.keyDown(screen.getByRole("menu", { name: "Thread actions" }), {
          key: "Escape",
        });
        await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
        return fill;
      };
      assert.deepEqual([await lifted("a"), await lifted("snoozed")], [ACTIVE_LIFT, RESTING_LIFT]);
      view.updateInbox({ activeThreadId: "snoozed" });
      assert.deepEqual([await lifted("snoozed"), await lifted("b")], [ACTIVE_LIFT, RESTING_LIFT]);
    });

    it("draws the touch sheet in bb's theme, whatever the OS colour scheme", async () => {
      const view = mount(hostState([thread("a")]), { isCompactViewport: true });
      await openMenu(row(view.slot, "a"), true);
      const menu = screen.getByRole("menu", { name: "Thread actions" });
      // A plugin's `dark:` variant follows the OS, not bb's theme, so a dark bb
      // on a light OS drew a white sheet. The sheet takes theme tokens only.
      const classes = [menu, ...menu.querySelectorAll("*")].flatMap((element) =>
        Array.from(element.classList),
      );
      assert.deepEqual(
        [
          classes.filter((name) => name.startsWith("dark:")),
          classes.includes("bg-popover/70"),
          within(menu)
            .getByRole("menuitem", { name: "Rename" })
            .classList.contains("active:bg-state-active"),
        ],
        [[], true, true],
      );
    });

    it("renders changed title, status, PR and split tint while retaining other rows", () => {
      const a = thread("a");
      const b = thread("b");
      let host = hostState([a, b]);
      const view = mount(host);
      rowBodyRender.mockClear();
      host = {
        ...host,
        sidebar: {
          ...host.sidebar,
          threads: [a, { ...b, title: "Renamed", displayTitle: "Renamed", isUnread: true }],
        },
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
    it("shows snoozed descendants beneath their parent", () => {
      const host = hostState([
        thread("root"),
        thread("child", { parentThreadId: "root" }),
        thread("grandchild", { parentThreadId: "child" }),
      ]);
      host.lifecycle = lifecycle(["root", "child", "grandchild"]);
      const view = mount(host);
      fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (3)" }));
      assert.deepEqual(rowIds(view.slot), ["root", "child", "grandchild"]);
      assert.ok(rowButton(view.slot, "root", "Collapse children of root"));
      assert.ok(rowButton(view.slot, "child", "Collapse children of child"));
    });

    it("does not offer Snooze on a parent while a descendant is working", async () => {
      const host = hostState([
        thread("root"),
        thread("child", { parentThreadId: "root", indicator: "runtime" }),
      ]);
      host.lifecycle = {
        ...lifecycle(),
        canPark: (item: PluginSidebarThread) => item.indicator !== "runtime",
      };
      const view = mount(host);
      fireEvent.contextMenu(row(view.slot, "root"));
      await act(async () => {});
      assert.equal(screen.queryByRole("menuitem", { name: "Snooze until tomorrow" }), null);
    });

    it("publishes focused split state independently of the parent route", () => {
      const host = {
        ...hostState([thread("root"), thread("child", { parentThreadId: "root" })]),
        splitThreads: ["root", "child"],
        focusedSplitThread: "child",
      };
      const view = mount(host, { activeThreadId: "root" }, true);
      const focused = (id: string) =>
        row(view.slot, id).parentElement!.getAttribute("data-sidebar-thread-focused");
      assert.equal(focused("root"), "false");
      assert.equal(focused("child"), "true");
      view.update({ host: { ...host, focusedSplitThread: "root" } });
      assert.equal(focused("root"), "true");
      assert.equal(focused("child"), "false");
      view.update({ host: { ...host, splitThreads: [] } });
      assert.equal(focused("root"), null);
      assert.equal(focused("child"), null);
    });

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
      "groups roots by project and keeps a cross-project child under its parent with desktop compact=%s",
      (compactThreads) => {
        const host = hostState([
          thread("root"),
          thread("child", { parentThreadId: "root" }),
          thread("cross-project", { parentThreadId: "root", projectId: "two" }),
          thread("other", { projectId: "two", latestAttentionAt: 50 }),
        ]);
        const view = mount(host, {}, compactThreads);
        assert.deepEqual(rowIds(view.slot), ["root", "child", "cross-project", "other"]);
        const root = row(view.slot, "root").parentElement!;
        const child = row(view.slot, "child").parentElement!;
        const crossProject = row(view.slot, "cross-project").parentElement!;
        assert.equal(root.classList.contains("gtd-compact-row"), compactThreads);
        assert.ok(child.classList.contains("gtd-compact-row"));
        assert.ok(crossProject.classList.contains("gtd-compact-row"));
        // The project lives in the group header, never on the title line.
        assert.equal(view.slot.container.querySelector(".gtd-project-chip"), null);
        const groups = Array.from(
          view.slot.container.querySelectorAll<HTMLElement>(".gtd-project-group"),
          (group) => group.dataset.projectId,
        );
        assert.deepEqual(groups, ["one", "two"]);
        assert.equal(
          crossProject.closest(".gtd-project-group")?.getAttribute("data-project-id"),
          "one",
        );
        assert.ok(view.slot.getByRole("button", { name: "One project" }));
        assert.ok(view.slot.getByRole("button", { name: "Two project" }));
        fireEvent.click(row(view.slot, "cross-project"), { ctrlKey: true });
        assert.deepEqual((host.actions.open as ReturnType<typeof actions>["open"]).mock.calls, [
          ["cross-project", { split: true }],
        ]);
      },
    );

    it("draws no project headers while every root shares one project", () => {
      const view = mount(
        hostState([
          thread("root"),
          thread("cross-project", { parentThreadId: "root", projectId: "two" }),
        ]),
      );
      assert.equal(view.slot.container.querySelector(".gtd-project-group"), null);
      assert.deepEqual(rowIds(view.slot), ["root", "cross-project"]);
    });

    it("folds a project group per shelf and counts what needs the user", () => {
      const view = mount(
        hostState([
          thread("a", { isUnread: true }),
          thread("b", { latestAttentionAt: 90 }),
          thread("c", { projectId: "two", latestAttentionAt: 80 }),
          thread("d", { projectId: "two", indicator: "runtime" }),
        ]),
      );
      assert.deepEqual(rowIds(view.slot), ["a", "b", "c", "d"]);
      fireEvent.click(view.slot.getByRole("button", { name: "One project" }));
      assert.deepEqual(rowIds(view.slot), ["c", "d"]);
      // The folded count is spoken in words, not as the visible "1 / 2".
      const one = view.slot.getByRole("button", { name: "One project, 2 threads, 1 needs you" });
      assert.equal(one.textContent, "One1 / 2");
      // Folding One under Next Action leaves Two open, and the Waiting shelf untouched.
      const waiting = row(view.slot, "d").closest("section");
      assert.equal(waiting?.getAttribute("aria-label"), "Waiting");
      fireEvent.click(one);
      assert.deepEqual(rowIds(view.slot), ["a", "b", "c", "d"]);
      fireEvent.click(within(waiting as HTMLElement).getByRole("button", { name: "Two project" }));
      assert.deepEqual(rowIds(view.slot), ["a", "b", "c"]);
      assert.ok(
        within(waiting as HTMLElement).getByRole("button", { name: "Two project, 1 thread" }),
      );
    });

    it("speaks a folded group's plural need-you count", () => {
      const view = mount(
        hostState([
          thread("a"),
          thread("b", { projectId: "two", isUnread: true }),
          thread("c", { projectId: "two", isUnread: true }),
        ]),
      );
      fireEvent.click(view.slot.getByRole("button", { name: "Two project" }));
      const two = view.slot.getByRole("button", { name: "Two project, 2 threads, 2 need you" });
      assert.equal(two.textContent, "Two2 / 2");
    });

    it("shows a folded group's chevron while its toggle has keyboard focus", () => {
      const view = mount(hostState([thread("a"), thread("b", { projectId: "two" })]));
      fireEvent.click(view.slot.getByRole("button", { name: "Two project" }));
      const toggle = view.slot.getByRole("button", { name: "Two project, 1 thread" });
      const glyph = () => toggle.querySelector("svg");
      assert.equal(glyph()?.getAttribute("data-icon"), "Folder");
      act(() => toggle.focus());
      assert.equal(glyph()?.getAttribute("data-icon"), "ChevronDown");
      assert.ok(glyph()?.classList.contains("-rotate-90"));
      act(() => toggle.blur());
      assert.equal(glyph()?.getAttribute("data-icon"), "Folder");
    });

    it("aligns grouped mobile parent, child, and leaf rows to their repo columns", () => {
      const view = mount(
        hostState([
          thread("root"),
          thread("child", { parentThreadId: "root" }),
          thread("other", { projectId: "two", latestAttentionAt: 50 }),
        ]),
        { isCompactViewport: true },
      );
      // Parent and child rows carry a disclosure/tree slot. Compact leaves
      // omit that slot unless their repository header establishes the column.
      const paddingLeft = (id: string) => row(view.slot, id).parentElement!.style.paddingLeft;
      assert.match(paddingLeft("root"), /var\(--gtd-group-indent/);
      assert.match(paddingLeft("child"), /var\(--gtd-group-indent/);
      assert.match(paddingLeft("other"), /var\(--gtd-leaf-group-indent/);
    });

    it("keeps a mobile family's title columns when it moves to Snoozed", () => {
      const threads = [
        thread("root"),
        thread("child", { parentThreadId: "root" }),
        thread("grandchild", { parentThreadId: "child" }),
      ];
      const host = hostState(threads);
      const view = mount(host, { isCompactViewport: true });
      // Each level clears the 32px touch chevron by 8px, one 16px step deeper.
      const columns = () =>
        ["root", "child", "grandchild"].map(
          (id) => row(view.slot, id).parentElement!.style.paddingLeft.match(/^calc\(\d+px/)?.[0],
        );
      assert.deepEqual(columns(), ["calc(40px", "calc(56px", "calc(72px"]);
      view.update({ host: { ...host, lifecycle: lifecycle(["root", "child", "grandchild"]) } });
      fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (3)" }));
      assert.deepEqual(columns(), ["calc(40px", "calc(56px", "calc(72px"]);
    });

    it("keeps group order put when the open thread changes", () => {
      const view = mount(
        hostState([
          thread("a", { latestAttentionAt: 300 }),
          thread("b", { projectId: "two", latestAttentionAt: 100 }),
        ]),
        { activeThreadId: "b" },
      );
      assert.deepEqual(rowIds(view.slot), ["a", "b"]);
      view.updateInbox({ activeThreadId: "a" });
      assert.deepEqual(rowIds(view.slot), ["a", "b"]);
    });

    it.each([false, true])(
      "opens a project's composer from its group header, mobile=%s",
      (mobile) => {
        const currentActions = actions();
        const onNavigate = mock(() => {});
        const view = mount(
          {
            ...hostState([thread("a"), thread("b", { projectId: "two" })]),
            actions: currentActions,
          },
          { onNavigate, isCompactViewport: mobile },
        );
        const toggle = view.slot.getByRole("button", { name: "Two project" });
        fireEvent.click(toggle);
        fireEvent.click(view.slot.getByRole("button", { name: "New thread in Two" }));
        assert.deepEqual(currentActions.openNewThread.mock.calls, [
          [{ projectId: "two", hostId: undefined, focusPrompt: true }],
        ]);
        assert.equal(onNavigate.mock.calls.length, 1);
        assert.equal(toggle.getAttribute("aria-expanded"), "false");
      },
    );

    it("preselects the scoped machine, including one with no threads yet", () => {
      const currentActions = actions();
      const host = hostState([thread("a", { host: { id: "host-a", name: "Studio" } })]);
      host.sidebar = { ...host.sidebar, experimental_hosts: [{ id: "host-b", name: "Empty" }] };
      host.actions = currentActions;
      const view = mount(host);
      fireEvent.keyDown(view.slot.getByRole("combobox", { name: "Machine scope: All machines" }), {
        key: "ArrowDown",
      });
      assert.deepEqual(
        screen.getAllByRole("option").map((option) => option.textContent),
        ["All machines", "Empty", "Studio"],
      );
      fireEvent.click(screen.getByRole("option", { name: "Studio" }));
      fireEvent.click(view.slot.getByRole("button", { name: "New thread in One" }));
      assert.deepEqual(currentActions.openNewThread.mock.calls, [
        [{ projectId: "one", hostId: "host-a", focusPrompt: true }],
      ]);
    });

    it.each([false, true])(
      "leads remote rows with the machine globe and local rows with an empty slot, compact=%s",
      (compactThreads) => {
        const localHost = { id: "local-host", name: "Local computer" };
        const remoteHost = { id: "remote-host", name: "Remote computer" };
        const view = mount(
          hostState([
            thread("root", { host: localHost }),
            thread("local-child", { parentThreadId: "root", host: localHost }),
            thread("remote-child", { parentThreadId: "root", host: remoteHost }),
          ]),
          {},
          compactThreads,
          localHost.id,
        );
        const root = row(view.slot, "root").parentElement!;
        const localChild = row(view.slot, "local-child").parentElement!;
        const remoteChild = row(view.slot, "remote-child").parentElement!;
        assert.equal(root.querySelector(".gtd-project-chip"), null);
        assert.equal(root.querySelector(".gtd-host-lead"), null);
        assert.equal(localChild.querySelector(".gtd-host-lead"), null);
        assert.ok(
          remoteChild.querySelector(
            '.gtd-host-lead [data-machine-id="remote-host"] [data-icon="Globe"]',
          ),
        );
        fireEvent.keyDown(
          view.slot.getByRole("combobox", { name: "Machine scope: All machines" }),
          { key: "ArrowDown" },
        );
        assert.ok(
          screen
            .getByRole("option", { name: "Local computer" })
            .querySelector('[data-icon="Globe"]'),
        );
      },
    );

    // The first paint lands before bb's primary host does. It must not draw a
    // globe it then takes away.
    it.each([
      ["", [], ["remote"], ["One", "One·Remote computer"]],
      ["remote-host", ["primary"], ["primary"], ["One·Primary computer", "One"]],
    ])(
      "names only machines other than bb's primary host or localMachineId=%p",
      async (localMachineId, firstPaint, globed, metadata) => {
        const host = hostState([
          thread("primary", { host: { id: "primary-host", name: "Primary computer" } }),
          thread("remote", { host: { id: "remote-host", name: "Remote computer" } }),
        ]);
        host.primaryHostId = "primary-host";
        const view = mount(host, {}, false, localMachineId);
        const card = (id: string) => row(view.slot, id).parentElement!;
        const globes = () =>
          ["primary", "remote"].filter((id) => card(id).querySelector(".gtd-host-lead"));
        assert.deepEqual(globes(), firstPaint);
        await waitFor(() => assert.deepEqual(globes(), globed));
        assert.deepEqual(
          ["primary", "remote"].map(
            (id) => card(id).querySelector(".gtd-thread-metadata")?.textContent,
          ),
          metadata,
        );
      },
    );

    it("opens compact thread details from the keyboard navigation anchor", async () => {
      const view = mount(
        hostState([thread("root"), thread("child", { parentThreadId: "root" })]),
        {},
        true,
      );
      act(() => row(view.slot, "child").focus());
      const tooltip = await screen.findByRole("tooltip");
      assert.match(tooltip.textContent ?? "", /child/);
      assert.match(tooltip.textContent ?? "", /One/);
      assert.match(tooltip.textContent ?? "", /Child of root/);
      assert.match(tooltip.textContent ?? "", /codex/);
      act(() => row(view.slot, "child").blur());
    });

    it("shows a two-line card's details only while its title is clipped", async () => {
      const view = mount(hostState([thread("clipped"), thread("short")]));
      clipTitle(view.slot, "clipped");

      act(() => row(view.slot, "short").focus());
      await act(async () => {});
      assert.equal(screen.queryByRole("tooltip"), null);

      act(() => row(view.slot, "clipped").focus());
      const tooltip = await screen.findByRole("tooltip");
      assert.equal(tooltip.firstElementChild?.textContent, "clipped");
      act(() => row(view.slot, "clipped").blur());
    });

    it("keeps a clipped card's details closed when a mouse-picked menu hands focus back", async () => {
      const view = mount(hostState([thread("a")]));
      const anchor = row(view.slot, "a");
      clipTitle(view.slot, "a");
      // jsdom rings every focus. A browser draws no ring for a click's focus,
      // nor for the focus a menu hands back after a mouse pick.
      const matches = anchor.matches.bind(anchor);
      anchor.matches = ((selectors: string) =>
        selectors !== ":focus-visible" && matches(selectors)) as typeof anchor.matches;

      act(() => anchor.focus());
      fireEvent.contextMenu(anchor);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" }));
      await waitFor(() => assert.equal(document.activeElement, anchor));
      await act(async () => {});
      assert.equal(screen.queryByRole("tooltip"), null);
    });

    it("still waits out the hover delay once a quietly hovered title clips", async () => {
      const view = mount(hostState([thread("a")]));
      const anchor = row(view.slot, "a");
      const dwell = () => act(() => new Promise((resolve) => setTimeout(resolve, 600)));
      fireEvent.pointerMove(anchor);
      await dwell();
      assert.equal(screen.queryByRole("tooltip"), null);
      fireEvent.pointerLeave(anchor);

      // The sidebar narrows, or the agent renames the thread, and the title clips.
      clipTitle(view.slot, "a");
      fireEvent.pointerMove(anchor);
      await act(async () => {});
      assert.equal(screen.queryByRole("tooltip"), null);
      await dwell();
      assert.equal(screen.getByRole("tooltip").firstElementChild?.textContent, "a");
      fireEvent.pointerDown(anchor);
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

    it("keeps a family with a working child in Waiting and settles through visible rows", () => {
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
      assert.deepEqual(rowIds(view.slot), ["next", "root", "child"]);
      const section = row(view.slot, "child").closest("section");
      assert.equal(section?.getAttribute("aria-label"), "Waiting");
      assert.equal(row(view.slot, "root").closest("section"), section);
      assert.equal(
        row(view.slot, "next").closest("section")?.getAttribute("aria-label"),
        "Next Action",
      );
      fireEvent.pointerDown(rowButton(view.slot, "child", "Settle"));
      assert.deepEqual(currentActions.archive.mock.calls, [["child"]]);
      // The grandchild makes bb confirm first; the advance follows the archive.
      assert.equal(currentActions.open.mock.calls.length, 0);
      view.update({
        host: {
          ...host,
          sidebar: {
            ...host.sidebar,
            threads: host.sidebar.threads.map((entry) =>
              entry.id === "child" || entry.id === "grandchild" ? settledThread(entry.id) : entry,
            ),
          },
        },
      });
      view.updateInbox({ activeThreadId: null });
      assert.deepEqual(currentActions.open.mock.calls, [["root"]]);
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

  describe("shelf headers", () => {
    it("names every shelf as a heading and points a folded chevron right", () => {
      const host = hostState([
        thread("pinned", { isPinned: true }),
        thread("a"),
        thread("waiting", { indicator: "runtime" }),
        thread("snoozed"),
        settledThread("settled"),
      ]);
      host.lifecycle = lifecycle(["snoozed"]);
      const view = mount(host);
      assert.deepEqual(
        view.slot.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
        ["Pinned", "Next Action", "Waiting", "Snoozed (1)", "Settled (1)"],
      );
      const toggles = () =>
        ["Waiting", "Snoozed", "Settled"].map((label) => {
          const shelf = within(view.slot.getByRole("region", { name: label }));
          const button = within(shelf.getByRole("heading", { level: 2 })).getByRole("button");
          const chevron = button.querySelector('[data-icon="ChevronDown"]');
          return [
            button.getAttribute("aria-expanded"),
            chevron?.getAttribute("class")?.includes("-rotate-90"),
          ];
        });
      assert.deepEqual(toggles(), [
        ["true", false],
        ["false", true],
        ["false", true],
      ]);
      fireEvent.click(view.slot.getByRole("button", { name: "Waiting" }));
      fireEvent.click(view.slot.getByRole("button", { name: "Snoozed (1)" }));
      assert.deepEqual(toggles(), [
        ["false", true],
        ["true", false],
        ["false", true],
      ]);
    });
  });

  describe("parked rows", () => {
    it.each([false, true])(
      "draws each restore button with its menu action's glyph, mobile=%s",
      (isCompactViewport) => {
        const host = hostState([thread("snoozed"), settledThread("settled")]);
        host.lifecycle = lifecycle(["snoozed"]);
        const view = mount(host, { isCompactViewport });
        expandParked(view.slot);
        const glyph = (id: string, name: string) =>
          rowButton(view.slot, id, name).querySelector("[data-icon]")?.getAttribute("data-icon");
        // Wake now matches the menu's AlarmClock, not the Snooze button's Clock.
        assert.deepEqual(
          [glyph("snoozed", "Wake now"), glyph("settled", "Un-settle")],
          ["AlarmClock", "ArrowTurnBackward"],
        );
      },
    );
  });

  describe("committed row commands", () => {
    it("matches machine selector and repo globe colors while composing scopes", async () => {
      const host = hostState([
        thread("a", { host: { id: "host-a", name: "Studio" } }),
        thread("b", { host: { id: "host-b", name: "Server" } }),
        thread("c", { projectId: "two", host: { id: "host-a", name: "Studio" } }),
      ]);
      // bb names no primary host, so every machine is remote once it answers.
      host.primaryHostId = null;
      const view = mount(host, {}, true);
      const chipGlobe = await waitFor(() => {
        const globe = view.slot.container.querySelector<HTMLElement>(
          '.gtd-host-lead [data-machine-id="host-a"]',
        );
        assert.ok(globe);
        return globe;
      });
      fireEvent.keyDown(view.slot.getByRole("combobox", { name: "Machine scope: All machines" }), {
        key: "ArrowDown",
      });
      const option = screen.getByRole("option", { name: "Studio" });
      assert.equal(
        option.querySelector<HTMLElement>("[data-machine-id]")?.style.color,
        chipGlobe.style.color,
      );
      fireEvent.click(option);
      assert.deepEqual(new Set(rowIds(view.slot)), new Set(["a", "c"]));
      const trigger = view.slot.getByRole("combobox", { name: "Machine scope: Studio" });
      assert.equal(
        trigger.querySelector<HTMLElement>("[data-machine-id]")?.style.color,
        chipGlobe.style.color,
      );
      assert.ok(view.slot.getByRole("combobox", { name: "Project scope: All projects" }));
      view.setGrouping(false);
      fireEvent.keyDown(view.slot.getByRole("combobox", { name: "Project scope: All projects" }), {
        key: "ArrowDown",
      });
      fireEvent.click(screen.getByRole("option", { name: "One" }));
      assert.deepEqual(rowIds(view.slot), ["a"]);
      view.setGrouping(true);
      assert.ok(view.slot.getByRole("combobox", { name: /Project scope:/ }));
      assert.ok(view.slot.getByRole("combobox", { name: "Project scope: One" }));
      assert.deepEqual(rowIds(view.slot), ["a"]);
    });

    it("keeps repository context under a machine filter and lets plugin settings hide groups", () => {
      const host = hostState([
        thread("studio", { host: { id: "host-a", name: "Studio" } }),
        thread("server", {
          projectId: "two",
          host: { id: "host-b", name: "Server" },
        }),
      ]);
      const view = mount(host);
      fireEvent.keyDown(view.slot.getByRole("combobox", { name: "Machine scope: All machines" }), {
        key: "ArrowDown",
      });
      fireEvent.click(screen.getByRole("option", { name: "Studio" }));

      assert.deepEqual(rowIds(view.slot), ["studio"]);
      assert.ok(view.slot.getByRole("button", { name: "One project" }));
      assert.equal(view.slot.queryByRole("button", { name: "Hide repository groups" }), null);
      assert.ok(view.slot.getByRole("combobox", { name: /Project scope:/ }));

      view.setGrouping(false);
      assert.equal(view.slot.container.querySelector(".gtd-project-group"), null);
      assert.ok(view.slot.getByRole("combobox", { name: "Project scope: All projects" }));

      view.setGrouping(true);
      assert.ok(view.slot.getByRole("button", { name: "One project" }));
      assert.ok(view.slot.getByRole("combobox", { name: /Project scope:/ }));
    });

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
      view.setGrouping(false);
      fireEvent.keyDown(view.slot.getByRole("combobox", { name: "Project scope: All projects" }), {
        key: "ArrowDown",
      });
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

    it("advances inside the settled row's own shelf, never across into the next one", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("pinned", { isPinned: true }),
          thread("a", { latestAttentionAt: 30 }),
          thread("c", { latestAttentionAt: 10 }),
          thread("waiting", { indicator: "runtime" }),
        ]),
        actions: currentActions,
      };
      const view = mount(host, { activeThreadId: "c" });
      // c ends Next Action. The flat list's next row is "waiting", but that
      // is another shelf; the advance is the row above c.
      fireEvent.pointerDown(rowButton(view.slot, "c", "Settle"));
      assert.deepEqual(currentActions.open.mock.calls, [["a"]]);
      assert.deepEqual(currentActions.archive.mock.calls, [["c"]]);
    });

    it("advances inside Pinned without spilling into Next Action", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("first", { isPinned: true, latestAttentionAt: 30 }),
          thread("last", { isPinned: true, latestAttentionAt: 20 }),
          thread("next", { latestAttentionAt: 10 }),
        ]),
        actions: currentActions,
      };
      const view = mount(host, { activeThreadId: "last" });
      fireEvent.pointerDown(rowButton(view.slot, "last", "Settle"));
      assert.deepEqual(currentActions.open.mock.calls, [["first"]]);
      assert.deepEqual(currentActions.archive.mock.calls, [["last"]]);
    });

    it("waits for bb's confirmation on a parent, then skips the children it archives", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("root", { latestAttentionAt: 200 }),
          thread("child", { parentThreadId: "root" }),
          thread("sibling", { latestAttentionAt: 50 }),
        ]),
        actions: currentActions,
      };
      const view = mount(host, { activeThreadId: "root" });
      // bb asks before archiving a parent, so nothing moves until it answers.
      fireEvent.pointerDown(rowButton(view.slot, "root", "Settle"));
      assert.deepEqual(currentActions.archive.mock.calls, [["root"]]);
      assert.equal(currentActions.open.mock.calls.length, 0);
      // Confirmed: bb leaves the archived thread, and the advance lands on the
      // next root, not on the child the archive took along.
      view.update({
        host: {
          ...host,
          sidebar: {
            ...host.sidebar,
            threads: host.sidebar.threads.map((entry) =>
              entry.id === "root" || entry.id === "child" ? settledThread(entry.id) : entry,
            ),
          },
        },
      });
      view.updateInbox({ activeThreadId: null });
      assert.deepEqual(currentActions.open.mock.calls, [["sibling"]]);
    });

    it("stays on a parent when bb's archive confirmation is cancelled", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("root", { latestAttentionAt: 200 }),
          thread("child", { parentThreadId: "root" }),
          thread("sibling", { latestAttentionAt: 50 }),
        ]),
        actions: currentActions,
      };
      const view = mount(host, { activeThreadId: "root" });
      fireEvent.pointerDown(rowButton(view.slot, "root", "Settle"));
      // Cancelled: the route never leaves root. Moving on by hand drops the advance.
      view.updateInbox({ activeThreadId: "sibling" });
      view.updateInbox({ activeThreadId: null });
      assert.equal(currentActions.open.mock.calls.length, 0);
    });

    it("does not advance on a cancelled settle when the composer opens next", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("root", { latestAttentionAt: 200 }),
          thread("child", { parentThreadId: "root" }),
          thread("sibling", { latestAttentionAt: 50 }),
        ]),
        actions: currentActions,
      };
      const view = mount(host, { activeThreadId: "root" });
      fireEvent.pointerDown(rowButton(view.slot, "root", "Settle"));
      // Cancelled: root stays live. Opening the composer by hand is not the
      // archive landing, so the neighbour must not open over it.
      view.updateInbox({ activeThreadId: null });
      assert.equal(currentActions.open.mock.calls.length, 0);
    });

    it("advances once the confirmed archive lands, whichever update arrives first", () => {
      for (const listFirst of [true, false]) {
        const currentActions = actions();
        const threads = [
          thread("root", { latestAttentionAt: 200 }),
          thread("child", { parentThreadId: "root" }),
          thread("sibling", { latestAttentionAt: 50 }),
        ];
        const host = { ...hostState(threads), actions: currentActions };
        const view = mount(host, { activeThreadId: "root" });
        fireEvent.pointerDown(rowButton(view.slot, "root", "Settle"));
        const archived = {
          ...host,
          sidebar: {
            ...host.sidebar,
            threads: threads.map((entry) =>
              entry.id === "root" || entry.id === "child" ? settledThread(entry.id) : entry,
            ),
          },
        };
        if (listFirst) {
          view.update({ host: archived });
          assert.equal(currentActions.open.mock.calls.length, 0, "list first: waits for route");
          view.updateInbox({ activeThreadId: null });
        } else {
          view.updateInbox({ activeThreadId: null });
          assert.equal(currentActions.open.mock.calls.length, 0, "route first: waits for list");
          view.update({ host: archived });
        }
        assert.deepEqual(currentActions.open.mock.calls, [["sibling"]], `listFirst=${listFirst}`);
        cleanup();
      }
    });

    it("settles through the palette the way a row's own Settle button does", () => {
      const currentActions = actions();
      const host = {
        ...hostState([
          thread("a", { latestAttentionAt: 30 }),
          thread("b", { latestAttentionAt: 20 }),
        ]),
        actions: currentActions,
      };
      mount(host, { activeThreadId: "a" });
      settleThread("a");
      assert.deepEqual(currentActions.open.mock.calls, [["b"]]);
      assert.deepEqual(currentActions.archive.mock.calls, [["a"]]);
    });

    it("settles against reordered rows while the selected row remains memoized", () => {
      const a = thread("a", { latestAttentionAt: 30 });
      const b = thread("b", { latestAttentionAt: 20 });
      const c = thread("c", { latestAttentionAt: 10 });
      const currentActions = actions();
      const host = { ...hostState([a, b, c]), actions: currentActions };
      const view = mount(host, { activeThreadId: "a" });
      rowBodyRender.mockClear();
      // A turn starting on b moves it to Waiting: the rows under the selected
      // one change without its body re-rendering.
      view.update({
        host: {
          ...host,
          sidebar: { ...host.sidebar, threads: [a, { ...b, indicator: "runtime" }, c] },
        },
      });
      assert.equal(rowBodyRender.mock.calls.length, 1);
      assert.deepEqual(rowIds(view.slot), ["a", "c", "b"]);
      fireEvent.pointerDown(rowButton(view.slot, "a", "Settle"));
      assert.deepEqual(currentActions.open.mock.calls, [["c"]]);
    });

    it("carries bb's jump key on the row and swaps its status slot for the pill", () => {
      const host = hostState([
        thread("a"),
        thread("b"),
        thread("snoozed"),
        settledThread("settled"),
      ]);
      host.lifecycle = lifecycle(["snoozed"]);
      const view = mount(host, {}, false, "", {
        sidebarShortcuts: {
          a: { label: "⌃1", ariaKeyshortcuts: "Control+1" },
          snoozed: { label: "⌃3", ariaKeyshortcuts: "Control+3" },
          settled: { label: "⌃4", ariaKeyshortcuts: "Control+4" },
        },
      });
      expandParked(view.slot);
      assert.equal(row(view.slot, "a").getAttribute("aria-keyshortcuts"), "Control+1");
      assert.equal(row(view.slot, "b").getAttribute("aria-keyshortcuts"), null);
      assert.equal(row(view.slot, "snoozed").getAttribute("aria-keyshortcuts"), "Control+3");
      assert.equal(row(view.slot, "settled").getAttribute("aria-keyshortcuts"), "Control+4");
      assert.deepEqual(
        Array.from(view.slot.container.querySelectorAll("kbd"), (pill) => pill.textContent),
        ["⌃1", "⌃3", "⌃4"],
      );
    });

    it("asks GitButler about plain checkouts only and prefers its label on the card", async () => {
      const environment = (id: string, isWorktree: boolean | null) => ({
        id,
        name: id,
        branchName: `${id}-branch`,
        path: `/repos/${id}`,
        isWorktree,
        providerId: null,
        workspaceDisplayKind: null,
      });
      const host = hostState([
        thread("plain", { environment: environment("env-plain", false) }),
        thread("worktree", { environment: environment("env-worktree", true) }),
        thread("unknown", { environment: environment("env-unknown", null) }),
      ]);
      const view = mount(host, {}, false, "", {
        settings: { gitButlerBranches: true },
        rpc: {
          listEnvironmentBranches: async () => ({
            environments: [{ environmentId: "env-plain", label: "scott/feature" }],
          }),
        },
      });
      await waitFor(() => assert.ok(view.slot.container.textContent!.includes("scott/feature")));
      assert.deepEqual(
        view.slot.rpcCalls
          .filter((call) => call.method === "listEnvironmentBranches")
          .map((call) => call.input),
        [{ environmentIds: ["env-plain"] }],
      );
      const text = view.slot.container.textContent!;
      assert.ok(!text.includes("env-plain-branch"));
      assert.ok(text.includes("env-worktree-branch"));
      assert.ok(text.includes("env-unknown-branch"));
    });

    it("uses current lifecycle actions and general navigation for settled mobile rows", () => {
      const oldLifecycle = lifecycle(["snoozed"]);
      const oldRestore = mock<HostState["unarchive"]>(async () => ({ ok: true }));
      const host = {
        ...hostState([thread("active"), thread("snoozed"), settledThread("settled")]),
        lifecycle: oldLifecycle,
        unarchive: oldRestore,
      };
      const oldNavigate = mock(() => {});
      const view = mount(host, { isCompactViewport: true, onNavigate: oldNavigate });
      expandParked(view.slot);
      const currentLifecycle = lifecycle(["snoozed"]);
      const currentRestore = mock<HostState["unarchive"]>(async () => ({ ok: true }));
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
          unarchive: currentRestore,
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
      assert.deepEqual(currentRestore.mock.calls, [[{ threadId: "settled" }]]);
      assert.equal(oldLifecycle.unsnooze.mock.calls.length, 0);
      assert.equal(oldRestore.mock.calls.length, 0);
      assert.equal(oldNavigate.mock.calls.length, 0);
    });

    it.each([false, true])(
      "allows mobile menu scrolling with haptics enabled, overflow=%s",
      async (overflow) => {
        const userAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
        Object.defineProperty(navigator, "userAgent", { configurable: true, value: "iPhone" });
        const prototype = dom.window.Element.prototype;
        const clientHeight = Object.getOwnPropertyDescriptor(prototype, "clientHeight")!;
        const scrollHeight = Object.getOwnPropertyDescriptor(prototype, "scrollHeight")!;
        Object.defineProperty(prototype, "clientHeight", {
          configurable: true,
          get: () => (overflow ? 100 : 400),
        });
        Object.defineProperty(prototype, "scrollHeight", { configurable: true, get: () => 400 });
        try {
          const view = mount(hostState([thread("a")]), { isCompactViewport: true }, false, "", {
            settings: { mobileHaptics: true },
          });
          await openMenu(row(view.slot, "a"), true);
          const menu = screen.getByRole("menu", { name: "Thread actions" });
          assert.equal(within(menu).getAllByRole("menuitem").length, 7);
          assert.equal(menu.querySelectorAll("[data-haptic-trigger]").length, overflow ? 0 : 7);
        } finally {
          cleanup();
          Object.defineProperty(prototype, "clientHeight", clientHeight);
          Object.defineProperty(prototype, "scrollHeight", scrollHeight);
          if (userAgent) Object.defineProperty(navigator, "userAgent", userAgent);
          else Reflect.deleteProperty(navigator, "userAgent");
        }
      },
    );

    it.each([false, true])(
      "keeps all actions in order for the clicked row with mobile=%s",
      async (isCompactViewport) => {
        const currentActions = actions();
        const host = { ...hostState([thread("a"), thread("b")]), actions: currentActions };
        const view = mount(host, { activeThreadId: "b", isCompactViewport });
        await openMenu(row(view.slot, "a"), isCompactViewport);
        await act(async () => {});
        assert.deepEqual(
          screen.getAllByRole("menuitem").map((item) => item.textContent),
          [
            "Settle",
            "Snooze until tomorrow",
            ...(!isCompactViewport ? ["Open in split"] : []),
            "Copy thread link",
            "Mark unread",
            "Pin",
            "Rename",
            "Delete",
          ],
        );
        assert.equal(screen.queryByRole("menuitem", { name: /archive/i }), null);
        if (!isCompactViewport) {
          fireEvent.click(screen.getByRole("menuitem", { name: "Open in split" }));
          assert.deepEqual(currentActions.open.mock.calls, [["a", { split: true }]]);
          await openMenu(row(view.slot, "a"), isCompactViewport);
        } else {
          assert.equal(screen.queryByRole("menuitem", { name: "Open in split" }), null);
        }
        fireEvent.click(screen.getByRole("menuitem", { name: "Mark unread" }));
        assert.deepEqual(currentActions.setRead.mock.calls, [["a", false]]);

        const writeText = mock(async (_text: string) => {});
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        await openMenu(row(view.slot, "a"), isCompactViewport);
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy thread link" }));
        await act(async () => {});
        assert.deepEqual(writeText.mock.calls, [["http://localhost/projects/one/threads/a"]]);

        await openMenu(row(view.slot, "a"), isCompactViewport);
        fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
        if (isCompactViewport) {
          assert.equal(
            document.activeElement,
            screen.getByRole("textbox", { name: "Thread name" }),
          );
        }
        const title = await screen.findByRole("textbox", { name: "Thread name" });
        await waitFor(() => assert.equal(document.activeElement, title));
        fireEvent.change(title, { target: { value: "  New title  " } });
        if (isCompactViewport) await holdInRenameInput(title, "  New title  ");
        fireEvent.keyDown(title, { key: "Enter" });
        await waitFor(() =>
          assert.equal(screen.queryByRole("textbox", { name: "Thread name" }) === null, true),
        );
        assert.deepEqual(currentActions.rename.mock.calls, [["a", "New title"]]);
      },
    );

    it.each([false, true])(
      "marks the target row read with mobile=%s",
      async (isCompactViewport) => {
        const currentActions = actions();
        const view = mount(
          { ...hostState([thread("a", { isUnread: true }), thread("b")]), actions: currentActions },
          { activeThreadId: "b", isCompactViewport },
        );
        await openMenu(row(view.slot, "a"), isCompactViewport);
        fireEvent.click(screen.getByRole("menuitem", { name: "Mark read" }));
        assert.deepEqual(currentActions.setRead.mock.calls, [["a", true]]);
        await act(async () => {});
      },
    );

    it.each([false, true])(
      "splits and renames settled threads with mobile=%s",
      async (isCompactViewport) => {
        const currentActions = actions();
        const host = hostState([thread("selected"), settledThread("settled")]);
        host.actions = currentActions;
        const view = mount(host, { activeThreadId: "selected", isCompactViewport });
        fireEvent.click(view.slot.getByRole("button", { name: "Settled (1)" }));
        await openMenu(row(view.slot, "settled"), isCompactViewport);
        assert.equal(screen.getAllByRole("menuitem")[0]?.textContent, "Un-settle");
        assert.equal(screen.queryByRole("menuitem", { name: /archive/i }), null);
        if (!isCompactViewport) {
          fireEvent.click(screen.getByRole("menuitem", { name: "Open in split" }));
          assert.deepEqual(currentActions.open.mock.calls, [["settled", { split: true }]]);
          await openMenu(row(view.slot, "settled"), isCompactViewport);
        } else {
          assert.equal(screen.queryByRole("menuitem", { name: "Open in split" }), null);
        }
        fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
        if (isCompactViewport) {
          assert.equal(
            document.activeElement,
            screen.getByRole("textbox", { name: "Thread name" }),
          );
        }
        const title = await screen.findByRole("textbox", { name: "Thread name" });
        await waitFor(() => assert.equal(document.activeElement, title));
        fireEvent.change(title, { target: { value: "Unsaved title" } });
        if (isCompactViewport) await holdInRenameInput(title, "Unsaved title");
        fireEvent.keyDown(title, { key: "Escape" });
        assert.equal(screen.queryByRole("textbox", { name: "Thread name" }), null);
        assert.equal(currentActions.rename.mock.calls.length, 0);
      },
    );

    it("draws the rename editor in its title's typography on cards and slim rows", async () => {
      // Layout-only classes differ on purpose: the editor takes clicks and
      // must not clip its error. Everything else must match the title.
      const layout = new Set([
        "pointer-events-none",
        "pointer-events-auto",
        "relative",
        "z-10",
        "truncate",
      ]);
      const typography = (element: Element | null | undefined) => {
        assert.ok(element);
        return [...element.classList].filter((name) => !layout.has(name)).sort();
      };
      // Cards draw `.gtd-thread-title`; a slim row's title is its one truncating span.
      const titleOf = (id: string) => {
        const container = row(view.slot, id).closest("[data-sidebar-rename-row]")!;
        return (
          container.querySelector(".gtd-thread-title") ?? container.querySelector("span.truncate")
        );
      };
      const editorFor = async (id: string) => {
        fireEvent.doubleClick(row(view.slot, id));
        const input = await screen.findByRole("textbox", { name: "Thread name" });
        const wrapper = input.closest("[data-sidebar-rename-editor]")!.parentElement;
        fireEvent.keyDown(input, { key: "Escape" });
        await waitFor(() =>
          assert.equal(screen.queryByRole("textbox", { name: "Thread name" }) === null, true),
        );
        return wrapper;
      };
      const view = mount(
        {
          ...hostState([
            thread("active", { isUnread: true, latestAttentionAt: 300 }),
            thread("child", { parentThreadId: "active" }),
            settledThread("parked"),
          ]),
        },
        { activeThreadId: "active" },
      );
      fireEvent.click(view.slot.getByRole("button", { name: "Settled (1)" }));

      for (const [id, expected] of [
        [
          "active",
          [
            "flex-1",
            "font-medium",
            "gtd-thread-title",
            "min-w-0",
            "text-sidebar-accent-foreground",
          ],
        ],
        ["child", ["flex-1", "gtd-thread-title", "min-w-0", "text-muted-foreground/70"]],
      ] as const) {
        const title = typography(titleOf(id));
        assert.deepEqual(title, [...expected].sort());
        assert.deepEqual(typography(await editorFor(id)), title);
      }
      const slimTitle = typography(titleOf("parked"));
      assert.ok(slimTitle.includes("group-hover/slim:text-foreground"));
      assert.deepEqual(typography(await editorFor("parked")), slimTitle);
    });

    it("renames in place on a double-click, keeping a failed draft for the retry", async () => {
      const currentActions = actions();
      currentActions.rename.mockImplementationOnce(async () => {
        throw new Error("offline");
      });
      const view = mount({ ...hostState([thread("a")]), actions: currentActions });
      fireEvent.doubleClick(view.slot.getByRole("link", { name: "a" }));
      const title = await screen.findByRole("textbox", { name: "Thread name" });
      assert.equal((title as HTMLInputElement).value, "a");

      fireEvent.change(title, { target: { value: "   " } });
      fireEvent.keyDown(title, { key: "Enter" });
      assert.equal(screen.getByRole("alert").textContent, "Name cannot be empty.");
      assert.equal(currentActions.rename.mock.calls.length, 0);

      fireEvent.change(title, { target: { value: "Renamed" } });
      await act(async () => {
        fireEvent.keyDown(title, { key: "Enter" });
      });
      assert.equal(screen.getByRole("alert").textContent, "Could not save the name. Try again.");
      assert.equal(
        (screen.getByRole("textbox", { name: "Thread name" }) as HTMLInputElement).value,
        "Renamed",
      );

      fireEvent.keyDown(screen.getByRole("textbox", { name: "Thread name" }), { key: "Enter" });
      await waitFor(() =>
        assert.equal(screen.queryByRole("textbox", { name: "Thread name" }) === null, true),
      );
      assert.deepEqual(currentActions.rename.mock.calls, [
        ["a", "Renamed"],
        ["a", "Renamed"],
      ]);
    });

    it("keeps the editor and its draft when the thread moves to another shelf", async () => {
      const currentActions = actions();
      const host = {
        ...hostState([thread("a", { indicator: "runtime" }), thread("b")]),
        actions: currentActions,
      };
      const view = mount(host);
      assert.equal(row(view.slot, "a").closest("section")?.getAttribute("aria-label"), "Waiting");
      fireEvent.doubleClick(view.slot.getByRole("link", { name: "a" }));
      const title = await screen.findByRole("textbox", { name: "Thread name" });
      fireEvent.change(title, { target: { value: "Half typed" } });

      // The agent finishes mid-edit: the row leaves Waiting for Next Action.
      view.update({
        host: { ...host, sidebar: { ...host.sidebar, threads: [thread("a"), thread("b")] } },
      });
      assert.equal(
        row(view.slot, "a").closest("section")?.getAttribute("aria-label"),
        "Next Action",
      );
      const moved = screen.getByRole("textbox", { name: "Thread name" }) as HTMLInputElement;
      assert.equal(moved.value, "Half typed");
      fireEvent.change(moved, { target: { value: "Half typed, then done" } });
      fireEvent.keyDown(moved, { key: "Enter" });
      await waitFor(() =>
        assert.equal(screen.queryByRole("textbox", { name: "Thread name" }) === null, true),
      );
      assert.deepEqual(currentActions.rename.mock.calls, [["a", "Half typed, then done"]]);
    });

    it("routes snooze, pin and delete through the current dispatcher", async () => {
      const oldLifecycle = lifecycle();
      const oldActions = actions();
      const host = { ...hostState([thread("a")]), lifecycle: oldLifecycle, actions: oldActions };
      const view = mount(host);
      const currentLifecycle = lifecycle();
      const currentActions = actions();
      view.update({ host: { ...host, lifecycle: currentLifecycle, actions: currentActions } });
      fireEvent.pointerDown(rowButton(view.slot, "a", "Snooze until tomorrow"));
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

  describe("list window", () => {
    // The row targets bb's next/previous-thread keys walk, in DOM order:
    // mounted anchors, and the threads each placeholder stands in for.
    function navigationOrder(slot: RenderedSlot): string[] {
      return Array.from(
        slot.container.querySelectorAll(
          "[data-sidebar-thread-shortcut-target], [data-sidebar-windowed-nav]",
        ),
      ).flatMap((element) =>
        element instanceof HTMLAnchorElement
          ? [element.dataset.sidebarThreadId!]
          : element
              .getAttribute("data-sidebar-windowed-nav")!
              .split(" ")
              .map((pair) => pair.split(":")[0]!),
      );
    }

    function scrollList(slot: RenderedSlot, top: number) {
      const scroller = slot.container.querySelector<HTMLElement>(".overflow-y-auto")!;
      Object.defineProperty(scroller, "scrollTop", { configurable: true, value: top });
      fireEvent.scroll(scroller);
    }

    const threads = Array.from({ length: 40 }, (_, index) =>
      thread(`t${String(index).padStart(2, "0")}`, { projectId: "one" }),
    );

    function everyRow() {
      const all = rowIds(mount(hostState(threads)).slot);
      cleanup();
      assert.equal(all.length, 40);
      return all;
    }

    it("mounts the rows in view and hands the rest to bb's next/previous keys", () => {
      const all = everyRow();
      layout.viewport = 200;
      layout.rowHeight = 32;
      const view = mount(hostState(threads));
      const mounted = rowIds(view.slot);
      assert.ok(mounted.length < 20, `mounted ${mounted.length} rows`);
      assert.deepEqual(mounted, all.slice(0, mounted.length));
      assert.deepEqual(navigationOrder(view.slot), all);
      const placeholder = view.slot.container.querySelector<HTMLElement>(
        "[data-sidebar-windowed-nav]",
      )!;
      // Unmounted cards stand in at their estimated 52px plus the 2px gap.
      assert.equal(placeholder.style.height, `${(40 - mounted.length) * 54}px`);
      assert.equal(placeholder.getAttribute("aria-hidden"), "true");
      assert.ok(
        placeholder
          .getAttribute("data-sidebar-windowed-nav")!
          .startsWith(`${all[mounted.length]}:one `),
      );
    });

    it("moves with the scroll, keeping the jump-key rows and the open thread mounted", () => {
      const all = everyRow();
      layout.viewport = 200;
      layout.rowHeight = 32;
      const view = mount(hostState(threads), { activeThreadId: all[39] });
      assert.ok(row(view.slot, all[39]!));
      // The first 20 rows mounted and measured 32px; the rest still stand
      // in at 54px, so 1,500px down is row 35.
      scrollList(view.slot, 1500);
      const mounted = rowIds(view.slot);
      for (const id of [...all.slice(0, 9), all[35]!, all[39]!]) {
        assert.ok(mounted.includes(id), id);
      }
      assert.ok(!mounted.includes(all[12]!));
      assert.deepEqual(navigationOrder(view.slot), all);
    });
  });
}
