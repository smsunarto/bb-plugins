import { expect, mock, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

installDom();
// installDom keeps node's Event classes; radix overlays dispatch theirs on jsdom nodes.
for (const name of ["Event", "CustomEvent", "FocusEvent", "KeyboardEvent", "PointerEvent"] as const)
  if (name in window)
    Object.defineProperty(globalThis, name, { configurable: true, value: window[name as "Event"] });
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");

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

async function mountCard(options: {
  scripts?: Array<{ id: string; name: string; command: string }> | Error;
  pullRequest?: { number: number; state: "open" | "draft" } | "unavailable" | "pending";
  status?: unknown;
  threads?: unknown[];
}) {
  pluginQueryClient.clear();
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const registration = app.threadHeaderActions.find((action) => action.id === "thread-details");
  if (!registration) throw new Error("thread-details is not registered");
  const send = mock(async (_input: unknown) => ({ ok: true }));
  const create = mock(async (_args: unknown) => ({ id: "term_1" }));
  const slot = renderSlot(
    registration,
    { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false },
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
