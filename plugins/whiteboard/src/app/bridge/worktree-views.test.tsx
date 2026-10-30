// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "../../server/lib/review/store.ts";
import { fakeLiveRead } from "../live-test-utils.ts";
import { ApiCanvas } from "../review/api-canvas.tsx";
import { testReviewBridge } from "../review/review-session-test-utils.tsx";

/** The canvas's RPC client and live session read, set per mount. */
const canvas = vi.hoisted(() => ({
  rpc: {} as object,
  live: undefined as { read: unknown } | undefined,
}));
vi.mock("../rpc.ts", () => ({ useWhiteboardRpc: () => canvas.rpc }));
vi.mock("../live.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live.ts")>()),
  useLiveRead: () => canvas.live!.read,
}));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(snapshot: LiveSnapshot, version?: number) {
  const live = fakeLiveRead<unknown>();
  live.push({
    ...snapshot,
    activity: { workingCount: 0, expiresAt: null },
    coverageRevision: 0,
  });
  canvas.live = live;
  canvas.rpc = {
    sessionVersion: async () => snapshot,
    commits: async () => [],
    history: async () => [],
    progress: async () => ({ files: [], lenses: [], resolvedSelections: {} }),
  };
  const bridge = testReviewBridge(
    {},
    {
      diffView: {
        files: async () => [{ path: "order.ts", status: "modified", additions: 1, deletions: 1 }],
        create(spec) {
          spec.container.textContent = "Native order.ts Diff";
          return { focus() {}, dispose() {}, onDidError: () => ({ dispose() {} }) };
        },
      },
    },
  );
  return render(
    <ApiCanvas content={{ kind: "api", reviewId: snapshot.reviewId, version, bridge }} />,
  );
}

it.each([undefined, 0])(
  "opens Diff for a current or retained worktree with equal commit pins: version=%s",
  async (version) => {
    const { container } = mount(
      {
        reviewId: "test-session",
        version: 0,
        title: "Dirty order",
        source: {
          target: { kind: "worktree", repositoryId: "r" },
          pins: {
            repositoryId: "r",
            base: "same-head",
            head: "same-head",
            worktreeRevision: "retained-dirty-tree",
          },
        },
        document: [],
        createdAt: "2026-09-17",
        live: { kind: "available", unavailableAnchors: [] },
      },
      version,
    );
    const diff = await screen.findByRole("button", { name: "Diff" });
    expect(diff.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Commits" })).toBeNull();
    fireEvent.click(diff);
    await waitFor(() => expect(diff.getAttribute("aria-pressed")).toBe("true"));
    expect(container.querySelector(".review-diff-view")?.getAttribute("aria-hidden")).toBe("false");
    expect(container.querySelector(".review-diff-view-host")?.textContent).toBe(
      "Native order.ts Diff",
    );
  },
);

it("keeps Diff and Commits available for an ordinary commit comparison", async () => {
  const { container } = mount({
    reviewId: "test-session",
    version: 0,
    title: "Committed order",
    source: {
      target: { kind: "commits", repositoryId: "r", base: "base", head: "head" },
      pins: { repositoryId: "r", base: "base", head: "head" },
    },
    document: [],
    createdAt: "2026-09-17",
    live: { kind: "available", unavailableAnchors: [] },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Diff" }));
  expect(container.querySelector(".review-diff-view")?.getAttribute("aria-hidden")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Commits" }));
  expect(screen.getByRole("button", { name: "Commits" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("0 commits").tagName).toBe("STRONG");
});
