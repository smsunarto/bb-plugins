import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { fireEvent, waitFor } from "@testing-library/react";
import { parseWorkspace } from "../src/host/parse.ts";
import { statusPayload } from "./fixtures.ts";

installDom();

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
  expect(slot.getByText("common base")).toBeTruthy();
  expect(slot.getByText("Before the common base")).toBeTruthy();
  await waitFor(() => expect(slot.getByText("chore: older work")).toBeTruthy());
  // The workspace is 3 commits behind its target.
  expect(slot.getByText("3 behind")).toBeTruthy();
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
  await waitFor(() => expect(slot.getByText("Uncommitted")).toBeTruthy());
  expect(slot.queryByText("bun.lock")).toBeNull();
  fireEvent.click(slot.getByText("Uncommitted"));

  await waitFor(() => expect(slot.getByText("bun.lock")).toBeTruthy());
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
