import { expect, mock, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
// installDom keeps node's Event classes; radix overlays dispatch theirs on jsdom nodes.
for (const name of ["Event", "CustomEvent", "FocusEvent", "KeyboardEvent", "PointerEvent"] as const)
  if (name in window)
    Object.defineProperty(globalThis, name, { configurable: true, value: window[name as "Event"] });
// jsdom has no layout, so nothing resizes; the docked card only needs the observer to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { createElement } = await import("react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { queryClient } = await import("../src/app/query.ts");

const ENV = "env_1";
const thread = {
  id: "thr_1",
  projectId: "proj_1",
  environment: {
    id: ENV,
    name: "bb-plugins",
    branchName: "scott/details",
    path: "/Users/scott/git/bb-plugins",
    isWorktree: false,
    providerId: "local",
    workspaceDisplayKind: null,
  },
  host: { id: "host_mac", name: "Scott's MacBook Pro" },
};

function workspaceStatus(insertions: number, deletions: number) {
  return {
    outcome: "available",
    workspace: {
      branch: { currentBranch: "scott/details", defaultBranch: "main" },
      checkout: { kind: "branch", branchName: "scott/details", headSha: null },
      mergeBase: null,
      workingTree: { insertions, deletions, fileCount: 3, files: [] },
    },
  };
}

type CardOptions = {
  scripts?: Array<{ id: string; name: string; command: string }> | Error;
  pullRequest?: { number: number; state: "open" | "draft" } | "unavailable" | "pending";
  status?: unknown;
  threads?: unknown[];
  compact?: boolean;
  /** Mount inside this element, as bb mounts the header inside its stream panel. */
  panel?: HTMLElement;
};

async function renderCard(options: CardOptions) {
  queryClient.clear();
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const registration = app.threadHeaderActions.find((action) => action.id === "thread-details");
  if (!registration) throw new Error("thread-details is not registered");
  const send = mock(async (_input: unknown) => ({ ok: true }));
  const create = mock(async (_args: unknown) => ({ id: "term_1" }));
  const statusRead = mock(async () => (options.status ?? workspaceStatus(2765, 161)) as never);
  // renderSlot appends its container to the body; route that one append into the panel.
  const { panel } = options;
  const append = document.body.appendChild;
  if (panel)
    document.body.appendChild = function <T extends Node>(node: T) {
      document.body.appendChild = append;
      return panel.appendChild(node);
    };
  const slot = renderSlot(
    registration,
    { threadId: "thr_1", projectId: "proj_1", isCompactViewport: options.compact ?? false },
    {
      pluginId: "kitchen-sink",
      sidebarThreads: {
        status: "ready",
        threads: (options.threads ?? [thread]) as never,
        projects: [{ id: "proj_1", name: "bb-plugins" } as never],
      },
      sdk: {
        environments: {
          status: statusRead,
        },
        terminals: { create: create as never },
      },
      rpc: {
        projectScripts: () => {
          if (options.scripts instanceof Error) throw options.scripts;
          return { scripts: options.scripts ?? [] };
        },
        askAgent: send,
        pullRequests: ({ keys }: { keys: string[] }) =>
          options.pullRequest === "pending"
            ? new Promise(() => {})
            : Object.fromEntries(
                keys.map((key) => [
                  key,
                  options.pullRequest === "unavailable"
                    ? { outcome: "unavailable", message: "gh is not signed in" }
                    : options.pullRequest
                      ? {
                          outcome: "available",
                          pullRequest: {
                            ...(options.pullRequest as object),
                            title: "Add thread details",
                            url: "https://github.com/o/r/pull/7",
                          },
                        }
                      : { outcome: "absent" },
                ]),
              ),
      } as never,
    },
  );
  const setCompact = (compact: boolean) =>
    slot.rerender(
      createElement(registration.component, {
        threadId: "thr_1",
        projectId: "proj_1",
        isCompactViewport: compact,
      }),
    );
  return { slot, send, create, statusRead, setCompact };
}

async function mountCard(options: CardOptions) {
  const { slot, send, create, statusRead, setCompact } = await renderCard(options);
  const card = await waitFor(() => {
    const element = document.body.querySelector<HTMLElement>(
      'section[aria-label="Thread details"]',
    );
    if (!element) throw new Error("card not open");
    return element;
  });
  return { slot, card, send, create, statusRead, setCompact };
}

test("the card shows the machine, script, branch, PR, and change rows", async () => {
  const { slot, card } = await mountCard({});
  const view = within(card);
  expect(view.getByText("Scott's MacBook Pro")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Open in editor" })).toBeNull();
  await waitFor(() => expect(view.getByText("Add project script")).toBeTruthy());
  expect(view.getByText("scott/details")).toBeTruthy();
  await waitFor(() => expect(view.getByText("+2,765")).toBeTruthy());
  expect(view.getByText("-161")).toBeTruthy();
  expect(view.getByText("Push & create PR")).toBeTruthy();
  slot.unmount();
});

test("Push & create PR asks the thread's agent", async () => {
  const { slot, card, send } = await mountCard({});
  fireEvent.click(within(card).getByText("Push & create PR"));
  await waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0]?.[0]).toEqual({ threadId: "thr_1", action: "push-and-create-pr" });
  slot.unmount();
});

test("an open pull request replaces the push row", async () => {
  const { slot, card } = await mountCard({ pullRequest: { number: 7, state: "open" } });
  await waitFor(() => expect(within(card).getByText("View PR #7")).toBeTruthy());
  expect(within(card).queryByText("Push & create PR")).toBeNull();
  slot.unmount();
});

test("a saved script runs in a thread terminal", async () => {
  const { slot, card, create } = await mountCard({
    scripts: [{ id: "s1", name: "Dev server", command: "bun run dev" }],
  });
  const run = await waitFor(() => within(card).getByText("Run Dev server"));
  fireEvent.click(run);
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    scope: { kind: "thread", threadId: "thr_1" },
    start: { mode: "command", command: "bun run dev" },
  });
  slot.unmount();
});

test("a pending or failed pull request lookup never offers to create one", async () => {
  const pending = await mountCard({ pullRequest: "pending" });
  await waitFor(() =>
    expect(within(pending.card).getByText("Checking pull request…")).toBeTruthy(),
  );
  expect(within(pending.card).queryByText("Push & create PR")).toBeNull();
  pending.slot.unmount();
  const failed = await mountCard({ pullRequest: "unavailable" });
  await waitFor(() =>
    expect(within(failed.card).getByText("Pull request status unavailable")).toBeTruthy(),
  );
  expect(within(failed.card).queryByText("Push & create PR")).toBeNull();
  failed.slot.unmount();
});

test("an unreadable checkout says so instead of reporting no changes", async () => {
  const { slot, card } = await mountCard({
    status: {
      outcome: "unavailable",
      failure: { code: "path_not_found", message: "gone", workspacePath: "/x" },
    },
  });
  // Earlier tests cached counts for this checkout, which stay visible marked stale.
  await waitFor(() =>
    expect(within(card).getByText(/^(Changes unavailable|Changes \(stale\))$/)).toBeTruthy(),
  );
  expect(within(card).queryByText("No changes")).toBeNull();
  slot.unmount();
});

test("scripts that fail to load cannot be overwritten from an empty list", async () => {
  const { slot, card } = await mountCard({ scripts: new Error("server unreachable") });
  await waitFor(() => expect(within(card).getByText("Scripts unavailable")).toBeTruthy(), {
    timeout: 4000,
  });
  expect(within(card).queryByText("Add project script")).toBeNull();
  slot.unmount();
});

test("a thread outside the active list shows a message, not an endless load", async () => {
  const { slot, card } = await mountCard({ threads: [] });
  expect(within(card).getByText("Details are shown for active threads.")).toBeTruthy();
  slot.unmount();
});

const PINNED = "kitchen-sink:thread-details:pinned";

/** bb's stream panel as react-resizable-panels renders it, with jsdom given a width. */
function streamPanel(width: number) {
  const panel = document.createElement("div");
  panel.dataset.panelId = "thread-detail-timeline-panel";
  panel.dataset.panelSize = width === 0 ? "0.0" : "100.0";
  panel.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, width, height: 600, right: width, bottom: 600 }) as DOMRect;
  document.body.append(panel);
  return panel;
}

const docked = () =>
  document.body.querySelector<HTMLElement>('section[aria-label="Thread details"]');
test("the card ignores the old hidden preference and stays visible while resizing", async () => {
  localStorage.setItem(PINNED, "false");
  const panel = streamPanel(900);
  const { slot } = await renderCard({ panel });
  await waitFor(() => expect(docked()).toBeTruthy());
  expect(within(slot.container).queryByRole("button", { name: "Thread details" })).toBeNull();
  panel.dataset.panelSize = "60.0";
  await waitFor(() => expect(docked()).toBeTruthy());
  fireEvent.keyDown(docked()!, { key: "Escape" });
  expect(docked()).toBeTruthy();
  slot.unmount();
  panel.remove();
  localStorage.removeItem(PINNED);
});

test("opening the right panel hides the card and closing it restores it", async () => {
  const panel = streamPanel(900);
  const group = document.createElement("div");
  group.setAttribute("data-panel-group", "");
  document.body.append(group);
  group.append(panel);
  const secondary = document.createElement("div");
  secondary.id = "thread-detail-secondary-panel";
  const aside = document.createElement("aside");
  aside.setAttribute("aria-hidden", "true");
  secondary.append(aside);
  group.append(secondary);
  const { slot } = await renderCard({ panel });
  await waitFor(() => expect(docked()).toBeTruthy());
  aside.setAttribute("aria-hidden", "false");
  await waitFor(() => expect(docked()).toBeNull());
  aside.setAttribute("aria-hidden", "true");
  await waitFor(() => expect(docked()).toBeTruthy());
  slot.unmount();
  group.remove();
});

test("an initially open right panel and a compact drawer hide the card", async () => {
  const panel = streamPanel(900);
  const group = document.createElement("div");
  group.setAttribute("data-panel-group", "");
  document.body.append(group);
  group.append(panel);
  const secondary = document.createElement("div");
  secondary.id = "thread-detail-secondary-panel";
  secondary.innerHTML = '<aside aria-hidden="false"></aside>';
  group.append(secondary);
  const { slot } = await renderCard({ panel });
  expect(docked()).toBeNull();
  secondary.remove();
  await waitFor(() => expect(docked()).toBeTruthy());
  const drawer = document.createElement("div");
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("data-state", "full");
  document.body.append(drawer);
  // BB opens the drawer with a fallback before its real panel arrives.
  await waitFor(() => expect(docked()).toBeTruthy());
  drawer.innerHTML = '<aside aria-hidden="false"></aside>';
  await waitFor(() => expect(docked()).toBeNull());
  drawer.setAttribute("data-state", "closed");
  await waitFor(() => expect(docked()).toBeTruthy());
  slot.unmount();
  drawer.remove();
  group.remove();
});

test("narrow desktop streams show the card; mobile and collapsed streams hide it", async () => {
  for (const [width, compact] of [
    [300, false],
    [0, false],
    [900, true],
  ] as const) {
    const panel = streamPanel(width);
    const { slot, statusRead } = await renderCard({ panel, compact });
    if (width === 0 || compact) expect(docked()).toBeNull();
    else await waitFor(() => expect(docked()).toBeTruthy());
    if (compact) {
      expect(
        within(slot.container).queryByRole("link", { name: "Go to thread details" }),
      ).toBeNull();
      expect(statusRead).not.toHaveBeenCalled();
    }
    expect(within(slot.container).queryByRole("button", { name: "Thread details" })).toBeNull();
    slot.unmount();
    panel.remove();
  }
});

test("checkout status can refresh while the card stays visible", async () => {
  const { slot, card, statusRead } = await mountCard({});
  const refresh = within(card).getByRole("button", { name: "Refresh checkout status" });
  await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
  const before = statusRead.mock.calls.length;
  statusRead.mockImplementation(async () => workspaceStatus(42, 7) as never);
  fireEvent.click(refresh);
  await waitFor(() => expect(within(card).getByText("+42")).toBeTruthy());
  expect(statusRead.mock.calls.length).toBeGreaterThan(before);
  expect(document.body.contains(card)).toBe(true);
  slot.unmount();
});

test("resizing to mobile hides the card without losing an open script draft", async () => {
  const { slot, card, setCompact } = await mountCard({});
  const add = await waitFor(() => within(card).getByText("Add project script"));
  fireEvent.click(add);
  const dialog = within(document.body).getByRole("dialog", { name: "Add project script" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "My script" } });
  fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "bun run dev" } });
  setCompact(true);
  expect(docked()).toBeNull();
  expect(document.body.contains(dialog)).toBe(true);
  setCompact(false);
  expect(docked()).toBeTruthy();
  expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("My script");
  expect(within(dialog).getByLabelText<HTMLTextAreaElement>("Command").value).toBe("bun run dev");
  slot.unmount();
});

test("split-pane cards stay within their own pane", async () => {
  const left = streamPanel(500);
  left.removeAttribute("data-panel-id");
  left.dataset.splitPaneId = "left";
  const first = await renderCard({ panel: left });
  const firstCard = docked()!;
  expect(firstCard.style.right).toBe(`${window.innerWidth - 500 + 12}px`);
  expect(firstCard.style.maxHeight).toBe("120px");
  const right = streamPanel(500);
  right.removeAttribute("data-panel-id");
  right.dataset.splitPaneId = "right";
  right.getBoundingClientRect = () =>
    ({ top: 0, left: 500, right: 1000, bottom: 600, width: 500, height: 600 }) as DOMRect;
  const second = await renderCard({ panel: right });
  const cards = document.body.querySelectorAll<HTMLElement>('section[aria-label="Thread details"]');
  expect(cards[1]?.style.right).toBe(`${Math.max(12, window.innerWidth - 1000 + 12)}px`);
  expect(cards[1]?.style.right).not.toBe(firstCard.style.right);
  first.slot.unmount();
  second.slot.unmount();
  left.remove();
  right.remove();
});

test("a shared right panel hides only its owning split pane's card", async () => {
  const group = document.createElement("div");
  group.setAttribute("data-panel-group", "");
  document.body.append(group);
  const first = streamPanel(500);
  first.removeAttribute("data-panel-id");
  first.dataset.splitPaneId = "pane-1";
  const second = streamPanel(500);
  second.removeAttribute("data-panel-id");
  second.dataset.splitPaneId = "pane-2";
  group.append(first, second);
  const firstSlot = await renderCard({ panel: first });
  const firstCard = docked()!;
  const secondSlot = await renderCard({ panel: second });
  const secondary = document.createElement("div");
  secondary.id = "thread-detail-secondary-panel-pane-2";
  secondary.innerHTML = '<aside aria-hidden="false"></aside>';
  group.append(secondary);
  await waitFor(() =>
    expect(document.querySelectorAll('section[aria-label="Thread details"]').length).toBe(1),
  );
  expect(firstCard.isConnected).toBe(true);
  const replacement = secondary.cloneNode(true) as HTMLElement;
  replacement.id = "thread-detail-secondary-panel-pane-1";
  secondary.replaceWith(replacement);
  await waitFor(() => expect(firstCard.isConnected).toBe(false));
  expect(document.querySelectorAll('section[aria-label="Thread details"]').length).toBe(1);
  firstSlot.slot.unmount();
  secondSlot.slot.unmount();
  group.remove();
});

test("the header keyboard link focuses the card without toggling it", async () => {
  const { slot, card } = await mountCard({});
  fireEvent.click(within(slot.container).getByRole("link", { name: "Go to thread details" }));
  expect(document.activeElement).toBe(card);
  slot.unmount();
});
