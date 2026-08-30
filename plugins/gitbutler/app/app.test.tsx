import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

installDom();
const { cleanup, fireEvent } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

afterEach(() => cleanup());

const patch = "@@ -1,1 +1,1 @@\n-old\n+new\n";
const hunkKey = `h1:${"a".repeat(64)}`;
const readyRepository = {
  kind: "ready" as const,
  repository: {
    environmentId: "env-1",
    gitButlerVersion: "0.22.3" as const,
    capturedAt: 1,
    mergeBase: { commitId: "0000000000000000000000000000000000000000", message: "base" },
    upstream: { behind: 0, lastFetched: null },
    stacks: [
      {
        rowKey: "stack-1",
        assignedFiles: [{ path: "assigned.ts", kind: "modified" as const }],
        branches: [
          {
            rowKey: "branch-1",
            branchName: "scott/alpha",
            status: { code: "completelyUnpushed", label: "Completely unpushed" },
            reviewId: null,
            ci: null,
            commits: [
              {
                commitId: "1111111111111111111111111111111111111111",
                changeId: "change-1",
                createdAt: "2026-08-30T00:00:00Z",
                message: "alpha commit",
                author: { name: "Scott", email: "scott@example.com" },
                conflicted: false,
                reviewId: null,
                files: [{ path: "committed.ts", kind: "added" as const }],
              },
            ],
            upstreamCommits: [],
          },
        ],
      },
      {
        rowKey: "stack-2",
        assignedFiles: [],
        branches: [
          {
            rowKey: "branch-2",
            branchName: "scott/beta",
            status: { code: "integrated", label: "Integrated" },
            reviewId: "(#2)",
            ci: {
              status: "complete",
              conclusion: "success",
              pendingChecks: [],
              passingChecks: ["test"],
              failingChecks: [],
            },
            commits: [],
            upstreamCommits: [],
          },
        ],
      },
    ],
    worktree: {
      hunkCount: 1,
      files: [
        {
          path: "src/a.ts",
          kind: "modified" as const,
          content: {
            kind: "text" as const,
            hunks: [
              {
                revisionKey: hunkKey,
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                patch,
              },
            ],
          },
        },
      ],
    },
  },
};

test("registers one flush GitButler thread action", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  expect(app.threadPanelActions).toHaveLength(1);
  expect(app.threadPanelActions[0]).toMatchObject({
    id: "gitbutler",
    title: "GitButler",
    layout: "flush",
  });
});

test("renders the resolving state", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const action = app.threadPanelActions[0];
  if (action === undefined) throw new Error("action missing");
  const slot = renderSlot(
    action,
    { threadId: "thread-1", params: null },
    { rpc: { repository: () => new Promise(() => undefined) } },
  );
  await slot.findByText("Finding this thread's GitButler workspace…");
  slot.unmount();
});

test("renders unavailable and failed states with retry", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const action = app.threadPanelActions[0];
  if (action === undefined) throw new Error("action missing");
  const unavailable = renderSlot(
    action,
    { threadId: "thread-1", params: null },
    {
      rpc: {
        repository: () => ({
          repository: {
            kind: "unavailable",
            issue: { code: "gitbutler-not-installed", message: "Install GitButler." },
          },
        }),
      },
    },
  );
  await unavailable.findByText("Install GitButler.");
  unavailable.unmount();

  const failed = renderSlot(
    action,
    { threadId: "thread-1", params: null },
    {
      rpc: { repository: () => Promise.reject(new Error("offline")) },
    },
  );
  await failed.findByText(/Failed to load GitButler: offline/u);
  failed.unmount();
});

test("renders multiple stacks with native file links and one native diff per hunk", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const action = app.threadPanelActions[0];
  if (action === undefined) throw new Error("action missing");
  const slot = renderSlot(
    action,
    { threadId: "thread-1", params: null },
    {
      rpc: { repository: () => ({ repository: readyRepository }) },
    },
  );
  expect(await slot.findAllByText("scott/alpha")).toHaveLength(2);
  expect(await slot.findAllByText("scott/beta")).toHaveLength(2);
  expect(slot.container.querySelectorAll('[data-testid="bb-diff"]')).toHaveLength(1);
  expect(slot.container.querySelector('[data-testid="bb-diff"]')?.getAttribute("data-path")).toBe(
    "src/a.ts",
  );
  expect(slot.container.querySelector('[data-testid="bb-diff"]')?.textContent).toBe(patch);
  const fileLink = await slot.findByText("src/a.ts");
  expect(fileLink.tagName).toBe("A");
  expect(fileLink.getAttribute("href")).toBe("./src%2Fa.ts");
  slot.unmount();
});

test("builds an explicit existing-branch commit intent from selected hunks", async () => {
  const inputs: unknown[] = [];
  const app = await loadPluginApp(() => import("./app.tsx"));
  const action = app.threadPanelActions[0];
  if (action === undefined) throw new Error("action missing");
  const slot = renderSlot(
    action,
    { threadId: "thread-1", params: null },
    {
      rpc: {
        repository: () => ({ repository: readyRepository }),
        commitSelection: (input) => {
          inputs.push(input);
          return {
            outcome: { kind: "rejected", code: "selection-stale", message: "stale" },
            repository: readyRepository,
          };
        },
      },
    },
  );
  const checkbox = await slot.findByRole("checkbox", { name: /Select hunk src\/a\.ts/u });
  fireEvent.click(checkbox);
  fireEvent.change(slot.getByLabelText("Commit message"), { target: { value: "panel commit" } });
  fireEvent.click(slot.getByRole("button", { name: "Commit 1 selected hunk" }));
  await slot.findByText("stale");
  expect(inputs[0]).toEqual({
    threadId: "thread-1",
    intent: {
      message: "panel commit",
      target: { kind: "existing", branchName: "scott/alpha" },
      hunkKeys: [hunkKey],
    },
  });
  slot.unmount();
});
