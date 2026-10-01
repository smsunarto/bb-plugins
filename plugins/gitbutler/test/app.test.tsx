import { beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { queryClient } from "../src/app/query-client.ts";
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

// The cache outlives the panel on purpose. Between tests it must not.
beforeEach(() => queryClient.clear());

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
    commit: () => ({
      commitId: "8f4598a1eaca7d3d7080a6756164040f0707d0d5",
      message: "feat(top): add the thing\n\nWith a body.",
      authorName: "Scott Sunarto",
      authorEmail: "github@smsunarto.com",
      files: [{ path: "src/app/app.tsx", kind: "modified" }],
    }),
    patches: () => ({
      files: [
        {
          path: "src/app/app.tsx",
          kind: "modified",
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

  // A file opens its diff.
  fireEvent.click(within(files).getByTitle("src/app/app.tsx"));
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Collapse src/app/app.tsx" })).toBeTruthy(),
  );

  fireEvent.click(slot.getByText("Workspace"));
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
  // Back on the workspace, the commit is still open. A second click closes it.
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
  await waitFor(() => expect(slot.getByText("Changed files")).toBeTruthy());
  expect(slot.getAllByRole("treeitem").map((row) => row.title)).toEqual([
    "src/app",
    "src/app/a.tsx",
    "src/app/b.tsx",
    "README.md",
  ]);
  // Back to the default, which the other tests assume.
  fireEvent.click(slot.getByRole("button", { name: "List view" }));
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
    const row = (path: string) =>
      slot.container.querySelector<HTMLElement>(`[data-row][title="${path}"]`)!;
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
      revision: "setup",
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
      revision: "missing",
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

function recordActions(result: () => unknown = () => ({ ok: true })) {
  const actions: unknown[] = [];
  return {
    actions,
    rpc: {
      ...baseRpc,
      branchAction: (input: { action: unknown }) => {
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
    action: { kind: "push", branch: "scott/bottom", force: false },
  });
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
  expect(card.getByText(/straight onto the target/)).toBeTruthy();
  expect(actions).toHaveLength(0);
  fireEvent.click(card.getByRole("button", { name: "Land" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "land",
    branch: "scott/bottom",
  });
  slot.lifecycle.unmount();
});

test("renames a branch from its name, and Escape leaves it alone", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Rename branch scott/bottom" }));
  fireEvent.keyDown(card.getByLabelText("New name for scott/bottom"), { key: "Escape" });
  expect(actions).toHaveLength(0);

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
