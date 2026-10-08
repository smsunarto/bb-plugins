import { beforeEach, expect, onTestFinished, test } from "bun:test";
import { environmentManager } from "@tanstack/react-query";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { installDom } from "@bb-kit/core/testing";
import { parseWorkspace } from "../src/host/parse.ts";
import { statusPayload } from "./fixtures.ts";

installDom();
// After the DOM exists: React DOM decides at load time whether the document
// supports `input` events, and without one it falls back to an IE-only path
// that breaks every controlled field.
const { fireEvent, waitFor, within } = await import("@testing-library/react");

/*
 * jsdom ships no ResizeObserver, and Pierre measures its own gutter on mount.
 * The panel's assertions are about what renders, not about layout, so an
 * inert observer is enough to let the diff cards mount.
 */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= InertResizeObserver;
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

const workspace = parseWorkspace(statusPayload, "bb-plugins");
// The fixture's scott/bottom commit is conflicted, for the parser's tests.
// `but` refuses to push or land that, and most cards here need both.
workspace.stacks[0]!.branches[1]!.commits[0]!.conflicted = false;

// The cache and the remembered repository outlive the panel on purpose.
// Between tests they must not.
beforeEach(() => {
  pluginQueryClient.clear();
  window.localStorage.clear();
});

async function panel(rpc: Record<string, (input: never) => unknown>) {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const registration = app.threadPanelActions[0]!;
  expect(registration.id).toBe("gitbutler");
  return renderSlot(
    registration,
    { threadId: "thread-1", params: null },
    {
      rpc: rpc as never,
      context: { threadId: "thread-1", projectId: "project-1" },
    },
  );
}

const baseRpc = {
  reviewRequests: () => ({ requests: [] }),
  conflictResolution: () => ({ subthread: null }),
  repositories: () => ({ repositories: [{ key: ".", name: "bb-plugins" }], reason: null }),
  workspace: () => workspace,
  baseHistory: () => ({
    commits: [
      {
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        message: "chore: older work",
        authorName: "Ada",
        createdAt: "2026-09-20T10:00:00+00:00",
      },
    ],
    hasMore: false,
    reason: null,
  }),
};

test("shows the stacks, their branches, the base, and the history below it", async () => {
  const slot = await panel(baseRpc);

  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  expect(slot.getByText("scott/bottom")).toBeTruthy();
  expect(slot.getByText("scott/experimental")).toBeTruthy();
  expect(slot.getByText("feat(top): add the thing")).toBeTruthy();
  expect(slot.getByRole("heading", { name: "Common base" })).toBeTruthy();
  expect(slot.getByText("Before the common base")).toBeTruthy();
  await waitFor(() => expect(slot.getByText("chore: older work")).toBeTruthy());
  // The workspace is 3 commits behind its target.
  expect(slot.getByText("3 behind")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("shows the workspace it already has when the panel is mounted again", async () => {
  let calls = 0;
  const rpc = {
    ...baseRpc,
    workspace: () => {
      calls += 1;
      return workspace;
    },
  };
  const first = await panel(rpc);
  await waitFor(() => expect(first.getByText("scott/top")).toBeTruthy());
  first.lifecycle.unmount();

  // No spinner on the way back: the stacks are on screen from the first
  // frame, and the refetch behind them is the ordinary background one.
  const second = await panel(rpc);
  expect(second.queryByText("Loading workspace…")).toBeNull();
  expect(second.getByText("scott/top")).toBeTruthy();
  await waitFor(() => expect(calls).toBe(2));
  second.lifecycle.unmount();
});

test("draws the last board and history at once after a reload, then checks them", async () => {
  const first = await panel(baseRpc);
  await waitFor(() => expect(first.getByText("chore: older work")).toBeTruthy());
  first.lifecycle.unmount();

  // A reload: memory is gone, storage is not, and the server is slow.
  pluginQueryClient.clear();
  let release: () => void = () => {};
  const second = await panel({
    ...baseRpc,
    workspace: () =>
      new Promise((resolve) => {
        release = () => resolve({ ...workspace, repoName: "bb-plugins renamed" });
      }),
  });
  expect(second.getByText("scott/top")).toBeTruthy();
  expect(second.getByText("chore: older work")).toBeTruthy();
  expect(second.queryByText("Loading workspace…")).toBeNull();
  expect(second.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("true");

  release();
  await waitFor(() =>
    expect(second.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe(
      "false",
    ),
  );
  second.lifecycle.unmount();
});

test("does not draw a stored board for a workspace that stopped being one", async () => {
  const first = await panel(baseRpc);
  await waitFor(() => expect(first.getByText("scott/top")).toBeTruthy());
  first.lifecycle.unmount();
  pluginQueryClient.clear();

  const notice = { ...workspace, state: "setupRequired" as const, stacks: [], base: null };
  const second = await panel({ ...baseRpc, workspace: () => notice });
  await waitFor(() =>
    expect(second.getByText("This repository is not a GitButler project")).toBeTruthy(),
  );
  second.lifecycle.unmount();

  // The notice replaced the stored board, so the next reload starts clean.
  pluginQueryClient.clear();
  const third = await panel({ ...baseRpc, workspace: () => new Promise(() => {}) });
  expect(third.queryByText("scott/top")).toBeNull();
  expect(third.getByText("Loading workspace…")).toBeTruthy();
  third.lifecycle.unmount();
});

test("starts a commit's diff loading when the pointer rests on its row", async () => {
  const asked: string[] = [];
  const slot = await panel({
    ...baseRpc,
    patches: (input: { source: { kind: string; commitId?: string } }) => {
      asked.push(input.source.commitId ?? input.source.kind);
      return { files: [], truncated: false };
    },
  });
  await waitFor(() => expect(slot.getByText("feat(top): add the thing")).toBeTruthy());
  const row = slot.getByText("feat(top): add the thing").closest("button")!;

  // A pointer passing straight over the row fetches nothing.
  fireEvent.pointerEnter(row);
  fireEvent.pointerLeave(row);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(asked).toEqual([]);

  fireEvent.pointerEnter(row);
  await waitFor(() => expect(asked).toHaveLength(1));

  // The click finds the answer already in, and does not ask again.
  fireEvent.click(row);
  await waitFor(() => expect(slot.getByRole("region", { name: "Changed files" })).toBeTruthy());
  expect(asked).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("keeps the history on screen while a longer page loads", async () => {
  let release: () => void = () => {};
  const slot = await panel({
    ...baseRpc,
    baseHistory: (input: { limit: number }) =>
      input.limit > 60
        ? new Promise((resolve) => {
            release = () =>
              resolve({
                commits: [
                  {
                    commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    message: "chore: older work",
                    authorName: "Ada",
                    createdAt: "2026-09-20T10:00:00+00:00",
                  },
                  {
                    commitId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    message: "chore: even older work",
                    authorName: "Ada",
                    createdAt: "2026-09-19T10:00:00+00:00",
                  },
                ],
                hasMore: false,
                reason: null,
              });
          })
        : { ...baseRpc.baseHistory(), hasMore: true },
  });

  await waitFor(() => expect(slot.getByText("chore: older work")).toBeTruthy());
  fireEvent.click(slot.getByText("Load more commits"));

  // The first page stays put until the second one lands.
  expect(slot.queryByText("Loading history…")).toBeNull();
  expect(slot.getByText("chore: older work")).toBeTruthy();
  release();
  await waitFor(() => expect(slot.getByText("chore: even older work")).toBeTruthy());
  slot.lifecycle.unmount();
});

test("names upstream commits rather than leaving the dot colour to say it", async () => {
  const slot = await panel(baseRpc);

  await waitFor(() => expect(slot.getByText("chore: someone else's push")).toBeTruthy());
  expect(slot.getByText(/Upstream, not in this branch/)).toBeTruthy();
  expect(slot.getByText("In this branch")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("keeps refresh reachable when the workspace query fails, and retries on click", async () => {
  let attempts = 0;
  const slot = await panel({
    ...baseRpc,
    workspace: () => {
      attempts += 1;
      throw new Error("but exited with code 1");
    },
  });

  // One retry, then the failure shows.
  await waitFor(() => expect(slot.getByText("GitButler could not be reached")).toBeTruthy(), {
    timeout: 4_000,
  });
  expect(slot.getByText("but exited with code 1")).toBeTruthy();
  expect(slot.getByLabelText("Refresh")).toBeTruthy();

  const before = attempts;
  fireEvent.click(slot.getByText("Try again"));
  await waitFor(() => expect(attempts).toBeGreaterThan(before), { timeout: 4_000 });
  slot.lifecycle.unmount();
});

test("lets the repository picker stand in for the name instead of printing both", async () => {
  const slot = await panel({
    ...baseRpc,
    repositories: () => ({
      repositories: [
        { key: ".", name: "bb-plugins" },
        { key: "repos/other", name: "other" },
      ],
      reason: null,
    }),
  });

  await waitFor(() => expect(slot.getByLabelText("Repository")).toBeTruthy());
  expect(slot.getAllByText("bb-plugins")).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("opens a commit and then one of its files as a diff", async () => {
  const slot = await panel({
    ...baseRpc,
    patches: () => ({
      files: [
        {
          path: "src/app/app.tsx",
          kind: "modified",
          previousPath: null,
          patch:
            "diff --git a/src/app/app.tsx b/src/app/app.tsx\n" +
            "--- a/src/app/app.tsx\n+++ b/src/app/app.tsx\n@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
        },
      ],
      truncated: false,
    }),
  });

  await waitFor(() => expect(slot.getByText("feat(top): add the thing")).toBeTruthy());
  fireEvent.click(slot.getByText("feat(top): add the thing"));

  // The commit opens in place, its files listed under its row, as GitButler shows them.
  const row = slot.getByText("feat(top): add the thing").closest("button")!;
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const files = await waitFor(() => slot.getByRole("region", { name: "Changed files" }));
  expect(row.closest("li")!.contains(files)).toBe(true);
  expect(within(files).getByText("+1")).toBeTruthy();
  expect(within(files).getByText("-1")).toBeTruthy();
  // The message body stays on the row.
  expect(slot.queryByText("With a body.")).toBeNull();
  expect(slot.inspection.rpcCalls.find((entry) => entry.method === "patches")?.input).toEqual({
    threadId: "thread-1",
    source: { kind: "commit", commitId: "8f4598a1eaca7d3d7080a6756164040f0707d0d5" },
  });

  // A file opens its diff, over the workspace, which waits behind it.
  const file = within(files).getByTitle("src/app/app.tsx");
  file.focus();
  fireEvent.click(file);
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Collapse src/app/app.tsx" })).toBeTruthy(),
  );
  const back = slot.getByRole("button", { name: "Back to workspace" });
  expect(document.activeElement).toBe(back);
  expect(row.closest("[inert]")).toBeTruthy();
  // The detail screen carries the whole message, body included.
  expect(slot.getByText("With a body.")).toBeTruthy();

  fireEvent.click(back);
  expect(slot.queryByRole("button", { name: "Back to workspace" })).toBeNull();
  // Focus is back on the file it left from, and the commit is still open.
  expect(document.activeElement).toBe(file);
  expect(row.closest("[inert]")).toBeNull();
  expect(row.getAttribute("aria-expanded")).toBe("true");

  // Escape goes back as well.
  fireEvent.click(file);
  await waitFor(() => expect(slot.getByRole("button", { name: "Back to workspace" })).toBeTruthy());
  fireEvent.keyDown(slot.getByRole("button", { name: "Back to workspace" }), { key: "Escape" });
  expect(slot.queryByRole("button", { name: "Back to workspace" })).toBeNull();

  // A second click on the commit closes it.
  fireEvent.click(slot.getByText("feat(top): add the thing"));
  expect(slot.queryByRole("region", { name: "Changed files" })).toBeNull();
  slot.lifecycle.unmount();
});

test("opens an uncommitted file straight into its working-tree diff", async () => {
  const slot = await panel({
    ...baseRpc,
    patches: () => ({
      files: [
        {
          path: "bun.lock",
          kind: "modified",
          previousPath: null,
          patch:
            "diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n",
          truncated: false,
        },
      ],
      truncated: false,
    }),
  });

  // Uncommitted starts collapsed, so the file list is one disclosure away.
  await waitFor(() => expect(slot.getByText("Uncommitted changes")).toBeTruthy());
  expect(slot.queryByText("bun.lock")).toBeNull();
  fireEvent.click(slot.getByText("Uncommitted changes"));

  await waitFor(() => expect(slot.getByText("bun.lock")).toBeTruthy());
  // The change kind is drawn as a glyph, so it has to carry its name.
  const row = slot.getByTitle("bun.lock");
  expect(within(row).getByText("Modified")).toBeTruthy();
  fireEvent.click(slot.getByText("bun.lock"));

  await waitFor(() => {
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "patches");
    expect(call?.input).toEqual({
      threadId: "thread-1",
      source: { kind: "uncommitted" },
    });
  });
  await waitFor(() => expect(slot.getByText("Changed files")).toBeTruthy());
  expect(slot.getByRole("button", { name: "Collapse bun.lock" })).toBeTruthy();
  slot.lifecycle.unmount();
});

const patch = (path: string, kind = "modified") => ({
  path,
  kind,
  previousPath: null,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
  truncated: false,
});

const threeFiles = {
  ...baseRpc,
  workspace: () => ({
    ...workspace,
    unassignedChanges: [
      { path: "src/app/b.tsx", kind: "modified" },
      { path: "src/app/a.tsx", kind: "added" },
      { path: "README.md", kind: "deleted" },
    ],
  }),
  patches: () => ({
    files: [patch("src/app/b.tsx"), patch("src/app/a.tsx", "added"), patch("README.md", "deleted")],
    truncated: false,
  }),
};

const openDiffs = (slot: { queryAllByRole: (role: string, options: object) => HTMLElement[] }) =>
  slot
    .queryAllByRole("button", { name: /^Collapse / })
    .map((button) => button.getAttribute("aria-label")!.replace("Collapse ", ""));

test("the tree view folds shared folders into one row, and every list follows the toggle", async () => {
  const slot = await panel(threeFiles);
  await waitFor(() => expect(slot.getByText("Uncommitted changes")).toBeTruthy());
  fireEvent.click(slot.getByText("Uncommitted changes"));

  // List view: the order git gave, each path whole.
  await waitFor(() => expect(slot.getByTitle("src/app/b.tsx")).toBeTruthy());
  const card = () => within(slot.getByRole("region", { name: "Uncommitted changes" }));
  fireEvent.click(card().getByRole("button", { name: "List view" }));
  expect(
    card()
      .getAllByRole("option")
      .map((row) => row.title),
  ).toEqual(["src/app/b.tsx", "src/app/a.tsx", "README.md"]);

  fireEvent.click(card().getByRole("button", { name: "Tree view" }));
  // `src` holds only `app`, so the two share a row. Folders come first, then names in order.
  const rows = () =>
    card()
      .getAllByRole("treeitem")
      .map((row) => row.title);
  expect(rows()).toEqual(["src/app", "src/app/a.tsx", "src/app/b.tsx", "README.md"]);
  // The assigned-changes card below switched with it.
  expect(
    slot.getByRole("region", { name: "Assigned changes" }).querySelector("[role=tree]"),
  ).toBeTruthy();
  expect(card().getByRole("treeitem", { name: "src/app" }).textContent).toBe("src/app");

  fireEvent.click(card().getByRole("treeitem", { name: "src/app" }));
  expect(rows()).toEqual(["src/app", "README.md"]);

  // The choice outlives the card: the detail screen opens in the tree too.
  fireEvent.click(card().getByRole("treeitem", { name: /README/ }));
  const detail = await waitFor(() => within(slot.getByRole("region", { name: "Changes" })));
  expect(detail.getAllByRole("treeitem").map((row) => row.title)).toEqual([
    "src/app",
    "src/app/a.tsx",
    "src/app/b.tsx",
    "README.md",
  ]);
  // Back to the default, which the other tests assume.
  fireEvent.click(detail.getByRole("button", { name: "List view" }));
  expect(window.localStorage.getItem("bb-plugin-gitbutler:file-list-mode")).toBe("list");
  slot.lifecycle.unmount();
});

test("a file opens every diff, scrolled to that file, and the list scrolls between them", async () => {
  // jsdom lays nothing out. Each diff card sits 100px below the last, 200px
  // down the scroll area, and the scroll area records where it is sent.
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const scrolls: number[] = [];
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const cards = [...document.querySelectorAll("[data-file-card]")];
    const index = cards.indexOf(this);
    return { top: index < 0 ? 0 : 200 + index * 100 } as DOMRect;
  };
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: () => 0,
    set: (value: number) => void scrolls.push(value),
  });
  try {
    const slot = await panel(threeFiles);
    await waitFor(() => expect(slot.getByText("Uncommitted changes")).toBeTruthy());
    fireEvent.click(slot.getByText("Uncommitted changes"));
    await waitFor(() => expect(slot.getByTitle("README.md")).toBeTruthy());
    fireEvent.click(slot.getByTitle("README.md"));

    // Every diff, in the list's order, and the third card brought to the top.
    await waitFor(() =>
      expect(openDiffs(slot)).toEqual(["src/app/b.tsx", "src/app/a.tsx", "README.md"]),
    );
    expect(scrolls).toEqual([392]);
    // The workspace stays mounted under the detail screen, with its own rows.
    const row = (path: string) =>
      slot
        .getByRole("region", { name: "Changes" })
        .querySelector<HTMLElement>(`[data-row][title="${path}"]`)!;
    expect(row("README.md").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(row("src/app/b.tsx"));
    expect(scrolls).toEqual([392, 192]);
    expect(row("src/app/b.tsx").getAttribute("aria-selected")).toBe("true");

    // The arrow keys scroll as they move.
    fireEvent.keyDown(row("src/app/b.tsx"), { key: "ArrowDown" });
    expect(scrolls).toEqual([392, 192, 292]);
    expect(document.activeElement).toBe(row("src/app/a.tsx"));
    expect(openDiffs(slot)).toHaveLength(3);
    slot.lifecycle.unmount();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
    if (scrollTop) Object.defineProperty(Element.prototype, "scrollTop", scrollTop);
  }
});

test("tells the user how to fix a repository that GitButler has not set up", async () => {
  const slot = await panel({
    ...baseRpc,
    workspace: () => ({
      state: "setupRequired",
      reason: "No GitButler project found at .",
      repoName: "",
      unassignedChanges: [],
      stacks: [],
      base: null,
      upstream: null,
    }),
  });

  await waitFor(() =>
    expect(slot.getByText("This repository is not a GitButler project")).toBeTruthy(),
  );
  expect(slot.getByText(/but setup/)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("says so when the GitButler CLI is missing on the host", async () => {
  const slot = await panel({
    ...baseRpc,
    workspace: () => ({
      state: "cliMissing",
      reason: "The GitButler CLI (but) is not installed on this environment's host.",
      repoName: "",
      unassignedChanges: [],
      stacks: [],
      base: null,
      upstream: null,
    }),
  });

  await waitFor(() =>
    expect(slot.getByText("The GitButler CLI is not installed here")).toBeTruthy(),
  );
  slot.lifecycle.unmount();
});

async function header(workspaceResult: () => unknown, isCompactViewport = false) {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const registration = app.threadHeaderActions[0]!;
  return renderSlot(
    registration,
    { threadId: "thread-1", projectId: "project-1", isCompactViewport },
    {
      rpc: { workspace: workspaceResult } as never,
      context: { threadId: "thread-1", projectId: "project-1" },
    },
  );
}

test("the header button opens the GitButler tab", async () => {
  const slot = await header(() => workspace);

  const button = await waitFor(() => slot.getByRole("button", { name: "View in GitButler" }));
  expect(button.textContent).toBe("View in GitButler");
  fireEvent.click(button);
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "openThreadPanel", options: { actionId: "gitbutler" } },
  ]);
  slot.lifecycle.unmount();
});

test("the header button is icon-only on compact viewports", async () => {
  const slot = await header(() => workspace, true);
  const button = await waitFor(() => slot.getByRole("button", { name: "View in GitButler" }));
  expect(button.textContent).toBe("");
  slot.lifecycle.unmount();
});

test("the header draws nothing outside a GitButler workspace", async () => {
  let asked = false;
  const slot = await header(() => {
    asked = true;
    return { ...workspace, state: "setupRequired", stacks: [] };
  });
  await waitFor(() => expect(asked).toBe(true));
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
});

function recordActions(result: () => unknown = () => ({ status: "done" })) {
  const actions: unknown[] = [];
  return {
    actions,
    rpc: {
      ...baseRpc,
      butAction: (input: { action: unknown }) => {
        actions.push(input);
        return result();
      },
    },
  };
}

async function bottomCard(rpc: Record<string, (input: never) => unknown>) {
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/bottom")).toBeTruthy());
  return { slot, card: within(slot.getByRole("article", { name: "Branch scott/bottom" })) };
}

test("offers only the actions a branch can take", async () => {
  const { slot, card } = await bottomCard(baseRpc);
  // Unpushed, no PR, and the bottom of its stack: all three apply.
  expect(card.getByRole("button", { name: "Push" })).toBeTruthy();
  expect(card.getByRole("button", { name: "Create PR" })).toBeTruthy();
  expect(card.getByRole("button", { name: "Land" })).toBeTruthy();
  // Pushed, with a PR, above another branch: nothing to send and cannot land alone.
  const top = within(slot.getByRole("article", { name: "Branch scott/top" }));
  expect(top.queryByRole("button", { name: "Push" })).toBeNull();
  expect(top.queryByRole("button", { name: "Create PR" })).toBeNull();
  expect(top.queryByRole("button", { name: "Land" })).toBeNull();
  slot.lifecycle.unmount();
});

test("pushes a branch by name from its card", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect(actions[0]).toEqual({
    threadId: "thread-1",
    action: { kind: "push", branch: "scott/bottom", force: false, acceptedLoss: [] },
  });
  slot.lifecycle.unmount();
});

test("a push refreshes the board but keeps an open commit's diff", async () => {
  const { actions, rpc } = recordActions();
  const reads = { workspace: 0, patches: 0 };
  const { slot, card } = await bottomCard({
    ...rpc,
    workspace: () => {
      reads.workspace += 1;
      return workspace;
    },
    patches: () => {
      reads.patches += 1;
      return { files: [], truncated: false };
    },
  });
  fireEvent.click(slot.getByText("feat(top): add the thing"));
  await waitFor(() => expect(reads.patches).toBe(1));
  const before = reads.workspace;

  fireEvent.click(card.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  await waitFor(() => expect(reads.workspace).toBe(before + 1));
  // A commit's diff is fixed by its id, so a write has no reason to fetch it again.
  expect(reads.patches).toBe(1);
  slot.lifecycle.unmount();
});

test("Create PR hands the branch to a subthread and links to it", async () => {
  const requests: unknown[] = [];
  let started: { branch: string; threadId: string; running: boolean }[] = [];
  const { slot, card } = await bottomCard({
    ...baseRpc,
    reviewRequests: () => ({ requests: started }),
    requestReview: (input: unknown) => {
      requests.push(input);
      started = [{ branch: "scott/bottom", threadId: "child-1", running: true }];
      return { threadId: "child-1" };
    },
  });
  fireEvent.click(card.getByRole("button", { name: "Create PR" }));
  await waitFor(() => expect(card.getByRole("button", { name: "Open subthread" })).toBeTruthy());
  expect(requests).toEqual([{ threadId: "thread-1", branch: "scott/bottom" }]);
  expect(card.getByRole("status").textContent).toContain(
    "A subthread is writing and opening the PR.",
  );
  // A second click would spawn a second subthread for the same PR, and
  // backing out of Land must not bring the button back.
  expect(card.queryByRole("button", { name: "Create PR" })).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Land" }));
  fireEvent.click(card.getByRole("button", { name: "Cancel" }));
  expect(card.queryByRole("button", { name: "Create PR" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a reopened panel finds the subthread still writing the PR", async () => {
  const { slot, card } = await bottomCard({
    ...baseRpc,
    reviewRequests: () => ({
      requests: [{ branch: "scott/bottom", threadId: "child-1", running: true }],
    }),
  });
  fireEvent.click(await waitFor(() => card.getByRole("button", { name: "Open subthread" })));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "child-1" }]);
  expect(card.queryByRole("button", { name: "Create PR" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a subthread that stopped without a PR leaves Create PR to retry", async () => {
  const { slot, card } = await bottomCard({
    ...baseRpc,
    reviewRequests: () => ({
      requests: [{ branch: "scott/bottom", threadId: "child-1", running: false }],
    }),
  });
  await waitFor(() =>
    expect(card.getByRole("status").textContent).toContain("stopped without opening a PR"),
  );
  expect(card.getByRole("button", { name: "Create PR" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("asks before landing, and lands only on the second click", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Land" }));
  expect(card.getByText(/can't easily be undone/)).toBeTruthy();
  expect(actions).toHaveLength(0);
  // Focus starts on the safe answer. Escape backs out to the Land button.
  expect(document.activeElement).toBe(card.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(card.getByRole("button", { name: "Cancel" }), { key: "Escape" });
  expect(card.queryByText(/can't easily be undone/)).toBeNull();
  expect(document.activeElement).toBe(card.getByRole("button", { name: "Land" }));

  fireEvent.click(card.getByRole("button", { name: "Land" }));
  fireEvent.click(card.getByRole("button", { name: "Land" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "land",
    branch: "scott/bottom",
  });
  slot.lifecycle.unmount();
});

test("hands the focus back to Land once, not each time a poll redraws it", async () => {
  // Integrated, the branch has nothing to land, so its Land button goes away.
  const integrated = structuredClone(workspace);
  const branches = integrated.stacks.flatMap((stack) => stack.branches);
  Object.assign(
    branches.find((branch) => branch.name === "scott/bottom")!,
    {
      status: "integrated",
    },
  );
  let landed = false;
  const { slot, card } = await bottomCard({
    ...baseRpc,
    workspace: () => (landed ? integrated : workspace),
  });
  fireEvent.click(card.getByRole("button", { name: "Land" }));
  fireEvent.click(card.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(card.getByRole("button", { name: "Land" }));

  // The reader moves on to bb's composer while the agent keeps working.
  const composer = document.body.appendChild(document.createElement("textarea"));
  composer.focus();
  landed = true;
  await pluginQueryClient.invalidateQueries();
  await waitFor(() => expect(card.queryByRole("button", { name: "Land" })).toBeNull());
  landed = false;
  await pluginQueryClient.invalidateQueries();
  await waitFor(() => expect(card.getByRole("button", { name: "Land" })).toBeTruthy());
  expect(document.activeElement).toBe(composer);
  composer.remove();
  slot.lifecycle.unmount();
});

test("a confirmed land runs to the end, with no Cancel to hide it", async () => {
  let finish = () => {};
  const { actions, rpc } = recordActions(
    () => new Promise((resolve) => (finish = () => resolve({ status: "done" }))),
  );
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Land" }));
  fireEvent.click(card.getByRole("button", { name: "Land" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  const cancel = card.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  await waitFor(() => expect(cancel.disabled).toBe(true));
  fireEvent.keyDown(cancel, { key: "Escape" });
  expect(card.getByText(/can't easily be undone/)).toBeTruthy();

  finish();
  await waitFor(() => expect(card.queryByText(/can't easily be undone/)).toBeNull());
  expect(actions).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("renames a branch from its name, and Escape leaves it alone", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Rename branch scott/bottom" }));
  fireEvent.keyDown(card.getByLabelText("New name for scott/bottom"), { key: "Escape" });
  expect(actions).toHaveLength(0);
  // The field is gone, so the name it came from takes the focus back.
  expect(document.activeElement).toBe(
    card.getByRole("button", { name: "Rename branch scott/bottom" }),
  );

  fireEvent.click(card.getByRole("button", { name: "Rename branch scott/bottom" }));
  const field = card.getByLabelText("New name for scott/bottom");
  fireEvent.change(field, { target: { value: "scott/base" } });
  fireEvent.blur(field);
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "rename",
    branch: "scott/bottom",
    name: "scott/base",
  });
  slot.lifecycle.unmount();
});

test("shows the CLI's refusal on the card that asked", async () => {
  const { rpc } = recordActions(() => {
    throw new Error("Unable to determine the forge for this project.");
  });
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Push" }));
  await waitFor(() =>
    expect(card.getByRole("alert").textContent).toContain("Unable to determine the forge"),
  );
  slot.lifecycle.unmount();
});

const notReady = {
  repoName: "",
  unassignedChanges: [],
  stacks: [],
  base: null,
  upstream: null,
};
const STALE = "Couldn't refresh. Showing the last workspace.";

test("a refresh that reads an error keeps the board and says it is stale", async () => {
  let failing = false;
  const slot = await panel({
    ...baseRpc,
    workspace: () =>
      failing ? { ...notReady, state: "error", reason: "The repository is locked." } : workspace,
  });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());

  failing = true;
  fireEvent.click(slot.getByLabelText("Refresh"));
  await waitFor(() => expect(slot.getByText(STALE)).toBeTruthy());
  expect(slot.getByText(STALE).title).toBe("The repository is locked.");
  expect(slot.getByText("scott/top")).toBeTruthy();
  expect(slot.getByText("bb-plugins")).toBeTruthy();
  expect(slot.queryByText("GitButler could not read this workspace")).toBeNull();

  // The next good read clears the note.
  failing = false;
  fireEvent.click(slot.getByLabelText("Refresh"));
  await waitFor(() => expect(slot.queryByText(STALE)).toBeNull());
  slot.lifecycle.unmount();
});

test("a refresh the host cannot answer keeps the board as well", async () => {
  let failing = false;
  const slot = await panel({
    ...baseRpc,
    workspace: () => {
      if (failing) throw new Error("socket closed");
      return workspace;
    },
  });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());

  failing = true;
  fireEvent.click(slot.getByLabelText("Refresh"));
  await waitFor(() => expect(slot.getByText(STALE)).toBeTruthy(), { timeout: 4_000 });
  expect(slot.getByText(STALE).title).toBe("socket closed");
  expect(slot.getByText("scott/top")).toBeTruthy();
  expect(slot.queryByText("GitButler could not be reached")).toBeNull();
  slot.lifecycle.unmount();
});

const STORED_REPOSITORY = "bb-plugin-gitbutler:repository:thread-1";

test("forgets a remembered repository that is no longer there", async () => {
  window.localStorage.setItem(STORED_REPOSITORY, "repos/gone");
  try {
    const slot = await panel(baseRpc);
    await waitFor(() => expect(window.localStorage.getItem(STORED_REPOSITORY)).toBeNull());
    const read = (call: { method: string }) => call.method === "workspace";
    expect(slot.inspection.rpcCalls.find(read)?.input).toEqual({
      threadId: "thread-1",
      repositoryKey: "repos/gone",
    });
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.findLast(read)?.input).toEqual({ threadId: "thread-1" }),
    );
    slot.lifecycle.unmount();
  } finally {
    window.localStorage.removeItem(STORED_REPOSITORY);
  }
});

test("keeps a remembered repository when discovery fails", async () => {
  window.localStorage.setItem(STORED_REPOSITORY, "repos/api");
  try {
    let listed = false;
    const slot = await panel({
      ...baseRpc,
      repositories: () => {
        listed = true;
        return { repositories: [], reason: "The environment could not be read." };
      },
    });
    await waitFor(() => expect(listed).toBe(true));
    await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
    expect(window.localStorage.getItem(STORED_REPOSITORY)).toBe("repos/api");
    slot.lifecycle.unmount();
  } finally {
    window.localStorage.removeItem(STORED_REPOSITORY);
  }
});

test("shows a branch's checks, and its PR chip opens the PR on the forge", async () => {
  const lookups: unknown[] = [];
  const slot = await panel({
    ...baseRpc,
    reviewUrl: (input: unknown) => {
      lookups.push(input);
      return { url: "https://github.com/acme/repo/pull/42" };
    },
  });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const top = within(slot.getByRole("article", { name: "Branch scott/top" }));
  // The fixture's review has a failing check. A branch with no review has no chip.
  expect(top.getByTitle("Checks failed").textContent).toBe("Checks failed");
  const bottom = within(slot.getByRole("article", { name: "Branch scott/bottom" }));
  expect(bottom.queryByTitle(/^Checks /)).toBeNull();

  // The link comes from the forge, so nothing asks for it until the click.
  const chip = top.getByRole("button", { name: "Open PR #42" });
  expect(chip.textContent).toBe("PR #42");
  expect(lookups).toEqual([]);
  fireEvent.click(chip);
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openUrl", url: "https://github.com/acme/repo/pull/42" },
    ]),
  );
  expect(lookups).toEqual([{ threadId: "thread-1", branch: "scott/top" }]);
  slot.lifecycle.unmount();
});

test("says so when the forge has no link for a branch's PR", async () => {
  const slot = await panel({ ...baseRpc, reviewUrl: () => ({ url: null }) });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const top = within(slot.getByRole("article", { name: "Branch scott/top" }));
  fireEvent.click(top.getByRole("button", { name: "Open PR #42" }));
  await waitFor(() =>
    expect(top.getByRole("alert").textContent).toBe(
      "GitButler could not find this PR on its forge.",
    ),
  );
  expect(slot.inspection.navigateCalls).toEqual([]);
  slot.lifecycle.unmount();

  // The answer is still cached, but a panel opened again has not asked yet.
  const again = await panel({ ...baseRpc, reviewUrl: () => ({ url: null }) });
  await waitFor(() => expect(again.getByText("scott/top")).toBeTruthy());
  const card = within(again.getByRole("article", { name: "Branch scott/top" }));
  expect(card.queryByRole("alert")).toBeNull();
  again.lifecycle.unmount();
});

test("asks before a force push deletes upstream commits, and only then", async () => {
  const forced = structuredClone(workspace);
  for (const branch of forced.stacks.flatMap((stack) => stack.branches)) {
    Object.assign(branch, { status: "diverged", push: "force" });
  }
  const { actions, rpc } = recordActions();
  const slot = await panel({ ...rpc, workspace: () => forced });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());

  // scott/top has an upstream commit that this push would delete.
  const top = within(slot.getByRole("article", { name: "Branch scott/top" }));
  fireEvent.click(top.getByRole("button", { name: "Force push" }));
  expect(
    top.getByText(/This deletes the upstream commit shown in this stack from the remote/),
  ).toBeTruthy();
  expect(actions).toHaveLength(0);
  fireEvent.click(top.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(top.getByRole("button", { name: "Force push" }));

  fireEvent.click(top.getByRole("button", { name: "Force push" }));
  fireEvent.click(top.getByRole("button", { name: "Force push" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "push",
    branch: "scott/top",
    force: true,
    // What the reader agreed to delete, by id, so the host stops if the remote has more.
    acceptedLoss: ["1111111111111111111111111111111111111111"],
  });

  // scott/bottom has none, so its force push replaces only its own commits.
  const bottom = within(slot.getByRole("article", { name: "Branch scott/bottom" }));
  fireEvent.click(bottom.getByRole("button", { name: "Force push" }));
  await waitFor(() => expect(actions).toHaveLength(2));
  expect((actions[1] as { action: unknown }).action).toEqual({
    kind: "push",
    branch: "scott/bottom",
    force: true,
    acceptedLoss: [],
  });
  slot.lifecycle.unmount();
});

test("asks before a force push deletes upstream commits on a branch below it", async () => {
  const forced = structuredClone(workspace);
  const [top, bottom] = forced.stacks[0]!.branches;
  // `but push scott/top` forces scott/bottom along with it, and only the
  // bottom branch has commits nobody has here.
  Object.assign(top!, { status: "diverged", push: "force", newUpstream: 0 });
  bottom!.upstreamCommits = top!.upstreamCommits;
  bottom!.newUpstream = 1;
  top!.upstreamCommits = [];
  const { actions, rpc } = recordActions();
  const slot = await panel({ ...rpc, workspace: () => forced });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());

  const card = within(slot.getByRole("article", { name: "Branch scott/top" }));
  fireEvent.click(card.getByRole("button", { name: "Force push" }));
  expect(
    card.getByText(/This deletes the upstream commit shown in this stack from the remote/),
  ).toBeTruthy();
  expect(actions).toHaveLength(0);
  slot.lifecycle.unmount();
});

test("asks before a plain push, too, when a branch below has upstream commits", async () => {
  const ahead = structuredClone(workspace);
  const [top, bottom] = ahead.stacks[0]!.branches;
  // `but push` forces by default, so a fast-forward of scott/top still
  // overwrites scott/bottom's remote.
  Object.assign(top!, { status: "ahead", push: "push", newUpstream: 0 });
  bottom!.upstreamCommits = top!.upstreamCommits;
  bottom!.newUpstream = 1;
  top!.upstreamCommits = [];
  const { actions, rpc } = recordActions();
  const slot = await panel({ ...rpc, workspace: () => ahead });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());

  const card = within(slot.getByRole("article", { name: "Branch scott/top" }));
  fireEvent.click(card.getByRole("button", { name: "Push" }));
  expect(
    card.getByText(/This deletes the upstream commit shown in this stack from the remote/),
  ).toBeTruthy();
  expect(actions).toHaveLength(0);
  fireEvent.click(card.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "push",
    branch: "scott/top",
    force: false,
    acceptedLoss: ["1111111111111111111111111111111111111111"],
  });
  slot.lifecycle.unmount();
});

test("drops an open confirmation when the reader switches repository", async () => {
  const forced = structuredClone(workspace);
  Object.assign(forced.stacks[0]!.branches[0]!, { status: "diverged", push: "force" });
  const { actions, rpc } = recordActions();
  const slot = await panel({
    ...rpc,
    repositories: () => ({
      repositories: [
        { key: ".", name: "bb-plugins" },
        { key: "repos/other", name: "other" },
      ],
      reason: null,
    }),
    // Both repositories have a scott/top.
    workspace: () => forced,
  });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  // Visit the other repository first, so both boards are cached and the
  // switch below swaps one for the other without a loading screen between.
  fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "repos/other" } });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "." } });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const before = within(slot.getByRole("article", { name: "Branch scott/top" }));
  fireEvent.click(before.getByRole("button", { name: "Force push" }));
  expect(before.getByText(/This deletes/)).toBeTruthy();

  fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "repos/other" } });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const after = within(slot.getByRole("article", { name: "Branch scott/top" }));
  expect(after.queryByText(/This deletes/)).toBeNull();
  expect(after.getByRole("button", { name: "Force push" })).toBeTruthy();
  expect(actions).toHaveLength(0);
  slot.lifecycle.unmount();
});

test("refuses a new name `but` would read as another branch's full ref", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Rename branch scott/bottom" }));
  const field = card.getByLabelText("New name for scott/bottom") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "refs/heads/topic" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(card.getByRole("alert").textContent).toBe("A branch name cannot start with refs/.");
  expect(actions).toHaveLength(0);
  slot.lifecycle.unmount();
});

test("keeps a branch name GitButler would refuse in the field, and says why", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Rename branch scott/bottom" }));
  const field = card.getByLabelText("New name for scott/bottom") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "my feature" } });
  fireEvent.keyDown(field, { key: "Enter" });

  expect(card.getByRole("alert").textContent).toBe(
    "A branch name cannot start with a dash or contain whitespace.",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");
  // Leaving the field keeps the typed name too.
  fireEvent.blur(field);
  expect(card.getByLabelText("New name for scott/bottom")).toBe(field);
  expect(field.value).toBe("my feature");
  expect(actions).toHaveLength(0);

  fireEvent.change(field, { target: { value: "my-feature" } });
  expect(card.queryByRole("alert")).toBeNull();
  fireEvent.blur(field);
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "rename",
    branch: "scott/bottom",
    name: "my-feature",
  });
  slot.lifecycle.unmount();
});

async function openUncommitted(rpc: Record<string, (input: never) => unknown>) {
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("Uncommitted changes")).toBeTruthy());
  fireEvent.click(slot.getByText("Uncommitted changes"));
  await waitFor(() => expect(slot.getByTitle("bun.lock")).toBeTruthy());
  fireEvent.click(slot.getByTitle("bun.lock"));
  return slot;
}

test("Back puts the focus on the board when the row that opened the diff has gone", async () => {
  let committed = false;
  const slot = await panel({
    ...baseRpc,
    workspace: () => (committed ? { ...workspace, unassignedChanges: [] } : workspace),
    patches: () => ({ files: [patch("bun.lock")], truncated: false }),
  });
  await waitFor(() => expect(slot.getByText("Uncommitted changes")).toBeTruthy());
  fireEvent.click(slot.getByText("Uncommitted changes"));
  const row = await waitFor(() => slot.getByTitle("bun.lock"));
  row.focus();
  fireEvent.click(row);
  const back = await waitFor(() => slot.getByRole("button", { name: "Back to workspace" }));

  // The agent commits the file while its diff is open.
  committed = true;
  await pluginQueryClient.invalidateQueries();
  await waitFor(() => expect(row.isConnected).toBe(false));
  fireEvent.click(back);
  // Not the page body, so Tab carries on from the top of the panel.
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement!.contains(slot.getByLabelText("Refresh"))).toBe(true);
  slot.lifecycle.unmount();
});

test("an uncommitted screen whose changes are gone says so, not that a commit is empty", async () => {
  const slot = await openUncommitted({
    ...baseRpc,
    patches: () => ({ files: [], truncated: false }),
  });
  await waitFor(() => expect(slot.getByText("No uncommitted changes")).toBeTruthy());
  expect(slot.queryByText(/This commit records no file contents/)).toBeNull();
  slot.lifecycle.unmount();
});

test("names a renamed file's old path, and marks a file too large to show", async () => {
  const slot = await openUncommitted({
    ...baseRpc,
    patches: () => ({
      files: [
        patch("bun.lock"),
        {
          path: "src/new-name.ts",
          kind: "renamed",
          previousPath: "src/old-name.ts",
          patch: "",
          truncated: false,
        },
        { path: "dist/app.js", kind: "modified", previousPath: null, patch: "", truncated: true },
      ],
      truncated: true,
    }),
  });
  const detail = await waitFor(() => within(slot.getByRole("region", { name: "Changes" })));
  // A binary file renamed and edited has no hunks either, so nothing claims the contents held.
  expect(detail.getByText("Renamed from src/old-name.ts.")).toBeTruthy();
  expect(detail.getByText("Too large")).toBeTruthy();
  expect(
    detail.getByText("This diff is too large to show. Open the file in your editor to read it."),
  ).toBeTruthy();
  // Past the budget the line totals would undercount, so the list header shows none.
  const list = within(detail.getByRole("region", { name: "Changed files" }));
  expect(list.queryByText("+1")).toBeNull();
  expect(detail.getAllByText("+1")).toHaveLength(1);
  slot.lifecycle.unmount();
});

function topCard(slot: Awaited<ReturnType<typeof panel>>) {
  return within(slot.getByRole("article", { name: "Branch scott/top" }));
}

/** Answers each `butAction` call with the next result, the last one repeating. */
function answering(...results: unknown[]) {
  let call = 0;
  return () => results[Math.min(call++, results.length - 1)];
}

test("a branch only behind its remote offers Pull and no push", async () => {
  const behind = structuredClone(workspace);
  const top = behind.stacks[0]!.branches.find((branch) => branch.name === "scott/top")!;
  Object.assign(top, { status: "behind", push: "none", newUpstream: 1 });
  const slot = await panel({ ...baseRpc, workspace: () => behind });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const card = topCard(slot);
  expect(card.getByText("Behind")).toBeTruthy();
  expect(card.getByRole("button", { name: "Pull" })).toBeTruthy();
  expect(card.queryByRole("button", { name: "Push" })).toBeNull();
  expect(card.queryByRole("button", { name: "Force push" })).toBeNull();
  slot.lifecycle.unmount();
});

test("offers Pull only when the remote has commits the branch lacks", async () => {
  const copies = structuredClone(workspace);
  // A rebased branch: its remote holds old copies of its own commits, nothing new.
  copies.stacks[0]!.branches.find((branch) => branch.name === "scott/top")!.newUpstream = 0;
  const slot = await panel({ ...baseRpc, workspace: () => copies });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  expect(topCard(slot).queryByRole("button", { name: "Pull" })).toBeNull();
  const bottom = within(slot.getByRole("article", { name: "Branch scott/bottom" }));
  expect(bottom.queryByRole("button", { name: "Pull" })).toBeNull();
  slot.lifecycle.unmount();
});

const TOP_CONFLICTS = { conflicted: ["scott/top"], overlapsUncommitted: false };

test("Pull runs on the branch, and asks before leaving conflicts", async () => {
  const { actions, rpc } = recordActions(
    answering(
      { status: "confirm", risk: TOP_CONFLICTS },
      { status: "confirm", risk: TOP_CONFLICTS },
      { status: "done" },
    ),
  );
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const card = topCard(slot);
  fireEvent.click(card.getByRole("button", { name: "Pull" }));
  await waitFor(() =>
    expect(card.getByText(/leaves conflicted commits in/).textContent).toBe(
      "Pulling scott/top leaves conflicted commits in scott/top. Resolve them before pushing.",
    ),
  );
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "pull",
    branch: "scott/top",
    accepted: null,
  });
  // Backing out returns to the Pull button and runs nothing more.
  fireEvent.keyDown(card.getByRole("button", { name: "Cancel" }), { key: "Escape" });
  expect(document.activeElement).toBe(card.getByRole("button", { name: "Pull" }));
  expect(actions).toHaveLength(1);

  fireEvent.click(card.getByRole("button", { name: "Pull" }));
  fireEvent.click(await card.findByRole("button", { name: "Pull anyway" }));
  await waitFor(() => expect(actions).toHaveLength(3));
  expect((actions[2] as { action: unknown }).action).toEqual({
    kind: "pull",
    branch: "scott/top",
    // The risk the reader saw, so the host asks again if it finds more.
    accepted: TOP_CONFLICTS,
  });
  await waitFor(() => expect(card.queryByText(/leaves conflicted commits/)).toBeNull());
  slot.lifecycle.unmount();
});

/**
 * Answers `butAction` a moment later, as a browser behaves meanwhile: the
 * disabled button that sent it loses the focus.
 */
function droppingFocus(result: unknown) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    // jsdom will not blur a disabled button, so the focus goes somewhere
    // that then disappears, which leaves it on the page as a browser does.
    const elsewhere = document.body.appendChild(document.createElement("button"));
    elsewhere.focus();
    elsewhere.remove();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return result;
  };
}

test("the focus comes back to the card once its request ends", async () => {
  const { rpc } = recordActions(droppingFocus({ status: "upToDate" }));
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const card = topCard(slot);
  card.getByRole("button", { name: "Pull" }).focus();
  fireEvent.click(card.getByRole("button", { name: "Pull" }));
  await card.findByRole("status");
  await waitFor(() =>
    expect(document.activeElement).toBe(card.getByRole("button", { name: "Pull" })),
  );
  slot.lifecycle.unmount();
});

test("the focus comes back to the header's Pull once it ends", async () => {
  const { rpc } = recordActions(droppingFocus({ status: "upToDate" }));
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  slot.getByRole("button", HEADER_PULL).focus();
  fireEvent.click(slot.getByRole("button", HEADER_PULL));
  await slot.findByText("Already up to date.");
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", HEADER_PULL)));
  slot.lifecycle.unmount();
});

test("Pull says so when the remote had nothing new", async () => {
  const { rpc } = recordActions(() => ({ status: "upToDate" }));
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  const card = topCard(slot);
  fireEvent.click(card.getByRole("button", { name: "Pull" }));
  expect((await card.findByRole("status")).textContent).toBe("Already up to date.");
  slot.lifecycle.unmount();
});

test("Delete asks first, says what is lost and what stays, and deletes by name", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Delete scott/bottom" }));
  // scott/bottom was never pushed and has scott/top stacked on it.
  expect(card.getByText(/^Delete \?/).textContent).toBe(
    "Delete scott/bottom? Its commit was never pushed, so only GitButler's undo history keeps it afterwards. The branch above it moves down onto the base.",
  );
  expect(actions).toHaveLength(0);
  expect(document.activeElement).toBe(card.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(card.getByRole("button", { name: "Cancel" }), { key: "Escape" });
  expect(document.activeElement).toBe(card.getByRole("button", { name: "Delete scott/bottom" }));

  fireEvent.click(card.getByRole("button", { name: "Delete scott/bottom" }));
  fireEvent.click(card.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "delete",
    branch: "scott/bottom",
    accepted: null,
  });
  slot.lifecycle.unmount();
});

test("Delete asks once more when uncommitted changes sit in the branch's files", async () => {
  const risk = { conflicted: [], overlapsUncommitted: true };
  const { actions, rpc } = recordActions(
    answering({ status: "confirm", risk }, { status: "done" }),
  );
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Delete scott/bottom" }));
  // Answered from the keyboard, so the focus sits on the answer.
  card.getByRole("button", { name: "Delete" }).focus();
  fireEvent.click(card.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(card.getByText(/^Your uncommitted changes/).textContent).toBe(
      "Your uncommitted changes touch files scott/bottom changed, so deleting it can write conflict markers into them.",
    ),
  );
  // A fresh question: the focus is on its Cancel, not the button that was just clicked.
  expect(document.activeElement).toBe(card.getByRole("button", { name: "Cancel" }));
  fireEvent.click(card.getByRole("button", { name: "Delete anyway" }));
  await waitFor(() => expect(actions).toHaveLength(2));
  expect((actions[1] as { action: unknown }).action).toEqual({
    kind: "delete",
    branch: "scott/bottom",
    accepted: risk,
  });
  slot.lifecycle.unmount();
});

test("a conflicted commit takes away every button that pushes it, from the branches above too", async () => {
  const conflicted = structuredClone(workspace);
  const [top, bottom] = conflicted.stacks[0]!.branches;
  bottom!.commits[0]!.conflicted = true;
  // scott/top has a commit of its own to push.
  Object.assign(top!, { status: "ahead", push: "push" });
  const slot = await panel({ ...baseRpc, workspace: () => conflicted });
  const card = within(await slot.findByRole("article", { name: "Branch scott/bottom" }));
  for (const name of ["Push", "Create PR", "Land"]) {
    expect(card.queryByRole("button", { name })).toBeNull();
  }
  expect(card.getByRole("button", { name: "Delete scott/bottom" })).toBeTruthy();
  // `but push scott/top` takes scott/bottom's conflicted commit along.
  for (const name of ["Push", "Force push", "Create PR"]) {
    expect(topCard(slot).queryByRole("button", { name })).toBeNull();
  }
  expect(topCard(slot).getByRole("button", { name: "Pull" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("deleting a pushed branch at the top of its stack loses nothing the remote lacks", async () => {
  const { slot } = await bottomCard(baseRpc);
  const card = topCard(slot);
  fireEvent.click(card.getByRole("button", { name: "Delete scott/top" }));
  expect(card.getByText(/^Delete \?/).textContent).toBe(
    "Delete scott/top? Its commit leaves the workspace. The remote branch and any PR stay.",
  );
  slot.lifecycle.unmount();
});

const HEADER_PULL = { name: "Pull the target branch into the workspace" };

const BOTH_AND_FILES = { conflicted: ["scott/top", "scott/bottom"], overlapsUncommitted: true };

test("the header's Pull updates the workspace, asking first about conflicts", async () => {
  const { actions, rpc } = recordActions(
    answering({ status: "confirm", risk: BOTH_AND_FILES }, { status: "done" }),
  );
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  fireEvent.click(slot.getByRole("button", HEADER_PULL));
  await waitFor(() =>
    expect(slot.getByText(/^Pulling leaves/).textContent).toBe(
      "Pulling leaves conflicted commits in scott/top and scott/bottom. Resolve them before pushing. Your uncommitted changes touch files the incoming commits change, so conflict markers can get written into them.",
    ),
  );
  expect(actions[0]).toEqual({
    threadId: "thread-1",
    action: { kind: "updateWorkspace", accepted: null },
  });
  fireEvent.click(slot.getByRole("button", { name: "Pull anyway" }));
  await waitFor(() => expect(actions).toHaveLength(2));
  expect((actions[1] as { action: unknown }).action).toEqual({
    kind: "updateWorkspace",
    accepted: BOTH_AND_FILES,
  });
  await waitFor(() => expect(slot.queryByText(/^Pulling leaves/)).toBeNull());
  slot.lifecycle.unmount();
});

test("the header's Pull can be backed out of, and says when nothing was new", async () => {
  const { actions, rpc } = recordActions(
    answering(
      { status: "confirm", risk: { conflicted: [], overlapsUncommitted: true } },
      { status: "upToDate" },
    ),
  );
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  fireEvent.click(slot.getByRole("button", HEADER_PULL));
  fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
  expect(slot.queryByText(/^Your uncommitted changes touch/)).toBeNull();
  expect(document.activeElement).toBe(slot.getByRole("button", HEADER_PULL));

  fireEvent.click(slot.getByRole("button", HEADER_PULL));
  await waitFor(() => expect(actions).toHaveLength(2));
  expect(await slot.findByText("Already up to date.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the header's Pull shows why it failed", async () => {
  const { rpc } = recordActions(() => {
    throw new Error("Could not reach the remote. Repository not found.");
  });
  const slot = await panel(rpc);
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  fireEvent.click(slot.getByRole("button", HEADER_PULL));
  await waitFor(() =>
    expect(slot.getByRole("alert").textContent).toBe(
      "Could not reach the remote. Repository not found.",
    ),
  );
  slot.lifecycle.unmount();
});

test("the header's Pull failure stays with its repository", async () => {
  const { rpc } = recordActions(() => {
    throw new Error("Could not reach the remote. Repository not found.");
  });
  const slot = await panel({
    ...rpc,
    repositories: () => ({
      repositories: [
        { key: ".", name: "bb-plugins" },
        { key: "repos/other", name: "other" },
      ],
      reason: null,
    }),
  });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "." } });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  fireEvent.click(slot.getByRole("button", HEADER_PULL));
  await waitFor(() => expect(slot.getByRole("alert")).toBeTruthy());

  fireEvent.change(slot.getByLabelText("Repository"), { target: { value: "repos/other" } });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  expect(slot.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("lists files left with conflict markers, which status keeps out of the changes", async () => {
  const conflicted = { ...workspace, conflictedFiles: ["README.md", "src/app.ts"] };
  const slot = await panel({ ...baseRpc, workspace: () => conflicted });
  const section = within(await slot.findByRole("region", { name: "Conflicts" }));
  expect(section.getByText("2 files hold conflict markers:")).toBeTruthy();
  expect(section.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "README.md",
    "src/app.ts",
  ]);
  expect(section.getByRole("button", { name: "Resolve conflicts" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a clean workspace has no conflicts section", async () => {
  const slot = await panel(baseRpc);
  await waitFor(() => expect(slot.getByText("scott/bottom")).toBeTruthy());
  expect(slot.queryByRole("region", { name: "Conflicts" })).toBeNull();
  slot.lifecycle.unmount();
});

/** The fixture with scott/bottom's commit conflicted again. */
function withConflictedBottom() {
  const conflicted = structuredClone(workspace);
  conflicted.stacks[0]!.branches[1]!.commits[0]!.conflicted = true;
  return conflicted;
}

test("Resolve conflicts hands every conflict to one subthread and links to it", async () => {
  const requests: unknown[] = [];
  let subthread: { threadId: string; running: boolean } | null = null;
  const slot = await panel({
    ...baseRpc,
    workspace: () => ({ ...withConflictedBottom(), conflictedFiles: ["README.md"] }),
    // Slow, as over a network: the link must not wait for a refetch.
    conflictResolution: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { subthread };
    },
    resolveConflicts: async (input: unknown) => {
      requests.push(input);
      const started = await droppingFocus({ threadId: "child-1" })();
      subthread = { threadId: "child-1", running: true };
      return started;
    },
  });
  const section = within(await slot.findByRole("region", { name: "Conflicts" }));
  expect(section.getByText(/conflicted commit/).textContent).toBe(
    "scott/bottom has a conflicted commit, which can't be pushed.",
  );
  expect(section.getByText("One file holds conflict markers:")).toBeTruthy();
  expect(section.getByRole("status").textContent).toBe("A subthread can resolve them for you.");

  section.getByRole("button", { name: "Resolve conflicts" }).focus();
  fireEvent.click(section.getByRole("button", { name: "Resolve conflicts" }));
  await waitFor(() => expect(section.getByRole("button", { name: "Open subthread" })).toBeTruthy());
  expect(requests).toEqual([{ threadId: "thread-1" }]);
  expect(section.getByRole("status").textContent).toBe("A subthread is resolving the conflicts.");
  // A second subthread would rewrite the same commits.
  expect(section.queryByRole("button", { name: "Resolve conflicts" })).toBeNull();
  // The button that started it is gone, so the focus moves to the link.
  await waitFor(() =>
    expect(document.activeElement).toBe(section.getByRole("button", { name: "Open subthread" })),
  );

  fireEvent.click(section.getByRole("button", { name: "Open subthread" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "child-1" }]);
  slot.lifecycle.unmount();
});

test("a click before the first read lands still shows the subthread it started", async () => {
  let subthread: { threadId: string; running: boolean } | null = null;
  const slot = await panel({
    ...baseRpc,
    workspace: withConflictedBottom,
    // Reads what is there when asked, and answers late.
    conflictResolution: async () => {
      const seen = subthread;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { subthread: seen };
    },
    resolveConflicts: () => {
      subthread = { threadId: "child-1", running: true };
      return { threadId: "child-1" };
    },
  });
  const section = within(await slot.findByRole("region", { name: "Conflicts" }));
  fireEvent.click(section.getByRole("button", { name: "Resolve conflicts" }));
  await waitFor(() => expect(section.getByRole("button", { name: "Open subthread" })).toBeTruthy());
  // Past the moment the stale first read would have answered.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(section.getByRole("status").textContent).toBe("A subthread is resolving the conflicts.");
  expect(section.queryByRole("button", { name: "Resolve conflicts" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a stopped conflict subthread is resumed, not replaced", async () => {
  const requests: unknown[] = [];
  const slot = await panel({
    ...baseRpc,
    workspace: withConflictedBottom,
    conflictResolution: () => ({ subthread: { threadId: "child-1", running: false } }),
    resolveConflicts: (input: unknown) => {
      requests.push(input);
      return { threadId: "child-1" };
    },
  });
  const section = within(await slot.findByRole("region", { name: "Conflicts" }));
  await waitFor(() =>
    expect(section.getByRole("status").textContent).toBe(
      "The conflict subthread has stopped. It may be waiting on you.",
    ),
  );
  expect(section.getByRole("button", { name: "Open subthread" })).toBeTruthy();
  // It may be waiting on an answer, so there is no button that starts a second one.
  expect(section.queryByRole("button", { name: "Resolve conflicts" })).toBeNull();

  fireEvent.click(section.getByRole("button", { name: "Continue resolving" }));
  await waitFor(() =>
    expect(section.getByRole("status").textContent).toBe("A subthread is resolving the conflicts."),
  );
  expect(requests).toEqual([{ threadId: "thread-1" }]);
  expect(section.queryByRole("button", { name: "Continue resolving" })).toBeNull();
  slot.lifecycle.unmount();
});

test("an open panel finds a subthread another thread started on the same workspace", async () => {
  // TanStack decided it runs on a server when it loaded, before the DOM was
  // installed, and a server never polls. This test is about the poll.
  environmentManager.setIsServer(() => false);
  onTestFinished(() => environmentManager.setIsServer(() => true));
  let subthread: { threadId: string; running: boolean } | null = null;
  const slot = await panel({
    ...baseRpc,
    workspace: withConflictedBottom,
    conflictResolution: () => {
      const seen = subthread;
      // Another thread's click lands after this panel's first read.
      subthread = { threadId: "child-9", running: true };
      return { subthread: seen };
    },
  });
  const section = within(await slot.findByRole("region", { name: "Conflicts" }));
  await waitFor(() =>
    expect(section.getByRole("status").textContent).toBe("A subthread can resolve them for you."),
  );
  await waitFor(
    () =>
      expect(section.getByRole("status").textContent).toBe(
        "A subthread is resolving the conflicts.",
      ),
    { timeout: 7_000 },
  );
  expect(section.queryByRole("button", { name: "Resolve conflicts" })).toBeNull();
  slot.lifecycle.unmount();
});

test("the resolver's own panel says it is the one resolving, with nothing to click", async () => {
  const slot = await panel({
    ...baseRpc,
    workspace: withConflictedBottom,
    conflictResolution: () => ({ subthread: { threadId: "thread-1", running: true } }),
  });
  const section = within(await slot.findByRole("region", { name: "Conflicts" }));
  await waitFor(() =>
    expect(section.getByRole("status").textContent).toBe("This thread is resolving the conflicts."),
  );
  expect(section.queryAllByRole("button")).toEqual([]);
  slot.lifecycle.unmount();
});

test("says why the subthread could not be resumed, and gives the focus back to the button", async () => {
  const slot = await panel({
    ...baseRpc,
    workspace: withConflictedBottom,
    conflictResolution: () => ({ subthread: { threadId: "child-1", running: false } }),
    resolveConflicts: async () => {
      await droppingFocus(null)();
      throw new Error("Thread not found");
    },
  });
  const section = within(await slot.findByRole("region", { name: "Conflicts" }));
  const resume = await waitFor(() => section.getByRole("button", { name: "Continue resolving" }));
  resume.focus();
  fireEvent.click(resume);
  await waitFor(() => expect(section.getByRole("alert").textContent).toBe("Thread not found"));
  // Not to Open subthread, which comes first in the row.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      section.getByRole("button", { name: "Continue resolving" }),
    ),
  );
  slot.lifecycle.unmount();
});

test("a force push over only the old copies of rebased commits goes straight out", async () => {
  const rebased = structuredClone(workspace);
  for (const branch of rebased.stacks.flatMap((stack) => stack.branches)) {
    // Each remote still lists the pre-rebase commits, but none of them is new.
    Object.assign(branch, { status: "diverged", push: "force", newUpstream: 0 });
  }
  const { actions, rpc } = recordActions();
  const slot = await panel({ ...rpc, workspace: () => rebased });
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  fireEvent.click(topCard(slot).getByRole("button", { name: "Force push" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "push",
    branch: "scott/top",
    force: true,
    acceptedLoss: [],
  });
  slot.lifecycle.unmount();
});
