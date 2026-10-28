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
          status: async () => (options.status ?? workspaceStatus(2765, 161)) as never,
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
  return { slot, send, create };
}

async function mountCard(options: CardOptions) {
  const { slot, send, create } = await renderCard(options);
  fireEvent.click(within(slot.container).getByRole("button", { name: "Thread details" }));
  const card = await waitFor(() => {
    const element = document.body.querySelector<HTMLElement>(
      '[aria-label="Thread details"][role="dialog"]',
    );
    if (!element) throw new Error("card not open");
    return element;
  });
  return { slot, card, send, create };
}

test("the card shows the machine, editor, script, branch, PR, and change rows", async () => {
  const { slot, card } = await mountCard({});
  const view = within(card);
  expect(view.getByText("Scott's MacBook Pro")).toBeTruthy();
  expect(view.getByText("Open in editor")).toBeTruthy();
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
const popover = () => document.body.querySelector('[aria-label="Thread details"][role="dialog"]');

test("in bb's stream the card is pinned by default and hides while the side panel is open", async () => {
  localStorage.removeItem(PINNED);
  const panel = streamPanel(900);
  const { slot } = await renderCard({ panel });
  const button = within(slot.container).getByRole("button", { name: "Thread details" });

  await waitFor(() => expect(docked()).toBeTruthy());
  expect(popover()).toBeNull();

  panel.dataset.panelSize = "60.0";
  await waitFor(() => expect(docked()).toBeNull());
  // Peeking while the side panel is open leaves the card pinned.
  fireEvent.click(button);
  await waitFor(() => expect(docked()).toBeTruthy());
  fireEvent.click(button);
  await waitFor(() => expect(docked()).toBeNull());
  expect(localStorage.getItem(PINNED)).toBeNull();

  panel.dataset.panelSize = "100.0";
  await waitFor(() => expect(docked()).toBeTruthy());
  fireEvent.click(button);
  await waitFor(() => expect(docked()).toBeNull());
  expect(localStorage.getItem(PINNED)).toBe("false");
  slot.unmount();
  panel.remove();
  localStorage.removeItem(PINNED);
});

test("a narrow stream, a collapsed one, or a phone uses the popover instead", async () => {
  for (const [width, compact] of [
    [300, false],
    [0, false],
    [900, true],
  ] as const) {
    const panel = streamPanel(width);
    const { slot } = await renderCard({ panel, compact });
    expect(docked()).toBeNull();
    fireEvent.click(within(slot.container).getByRole("button", { name: "Thread details" }));
    await waitFor(() => expect(popover()).toBeTruthy());
    expect(docked()).toBeNull();
    slot.unmount();
    panel.remove();
  }
});

test("Escape closes the popover and returns focus to the button", async () => {
  const { slot, card } = await mountCard({});
  const button = within(slot.container).getByRole("button", { name: "Thread details" });
  fireEvent.keyDown(card, { key: "Escape" });
  await waitFor(() => expect(popover()).toBeNull());
  expect(document.activeElement).toBe(button);
  slot.unmount();
});
