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

  // The detail screen is the file list. The message body stays on the row.
  expect(slot.queryByText("With a body.")).toBeNull();
  await waitFor(() => expect(slot.getByText("1 file changed")).toBeTruthy());

  await waitFor(() => {
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "patches");
    expect(call?.input).toEqual({
      threadId: "thread-1",
      source: { kind: "commit", commitId: "8f4598a1eaca7d3d7080a6756164040f0707d0d5" },
    });
  });

  fireEvent.click(slot.getByText("Workspace"));
  await waitFor(() => expect(slot.getByText("scott/top")).toBeTruthy());
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
  await waitFor(() => expect(slot.getByText("1 file changed")).toBeTruthy());
  slot.lifecycle.unmount();
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

test("drafts a PR from the branch's lone commit and sends what the user edited", async () => {
  const { actions, rpc } = recordActions();
  const { slot, card } = await bottomCard(rpc);
  fireEvent.click(card.getByRole("button", { name: "Create PR" }));
  const title = card.getByLabelText("PR title") as HTMLInputElement;
  expect(title.value).toBe("fix(bottom): repair it");
  fireEvent.change(card.getByLabelText("PR description"), { target: { value: "Why." } });
  fireEvent.click(card.getByLabelText("Draft"));
  fireEvent.click(card.getByRole("button", { name: "Create PR" }));
  await waitFor(() => expect(actions).toHaveLength(1));
  expect((actions[0] as { action: unknown }).action).toEqual({
    kind: "createReview",
    branch: "scott/bottom",
    title: "fix(bottom): repair it",
    body: "Why.",
    draft: true,
  });
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
