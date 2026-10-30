// @vitest-environment jsdom
import { experimental_PluginRpcCallError as PluginRpcCallError } from "@get-bb/plugin-sdk/app";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "../../server/lib/review/store.ts";
import { fakeLiveRead } from "../live-test-utils.ts";
import { ApiCanvas } from "../review/api-canvas.tsx";
import { createDocumentLoader } from "../review/api-document.tsx";
import { testReviewBridge } from "../review/review-session-test-utils.tsx";

/** The canvas's RPC client and live session read. */
const canvas = vi.hoisted(() => ({
  rpc: {} as object,
  live: undefined as { read: unknown } | undefined,
}));
vi.mock("../rpc.ts", () => ({ useWhiteboardRpc: () => canvas.rpc }));
vi.mock("../live.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live.ts")>()),
  useLiveRead: () => canvas.live!.read,
}));

vi.mock("../review/App.tsx", () => ({
  App: () => <div>Canvas ready</div>,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const snapshot: LiveSnapshot = {
  reviewId: "test-session",
  version: 0,
  title: "Order",
  source: {
    target: { kind: "worktree", repositoryId: "r" },
    pins: { repositoryId: "r", base: "b", head: "h", worktreeRevision: "dirty-one" },
  },
  document: [],
  createdAt: "2026-09-17",
  live: { kind: "available", unavailableAnchors: [] },
};

it("publishes the latest authored source version when pins do not change", async () => {
  const live = fakeLiveRead<unknown>();
  canvas.live = live;
  canvas.rpc = {
    commits: async () => [],
    progress: async () => ({ files: [], lenses: [], resolvedSelections: {} }),
  };
  const following = (version: number) => ({
    ...snapshot,
    version,
    activity: { workingCount: 0, expiresAt: null },
    coverageRevision: 0,
  });
  const setSourceView = vi.fn();
  render(
    <ApiCanvas
      content={{
        kind: "api",
        reviewId: snapshot.reviewId,
        bridge: testReviewBridge(),
        setSourceView,
      }}
    />,
  );
  await waitFor(() => expect(live.followers()).toBe(1));
  await act(async () => live.push(following(0)));
  await screen.findByText("Canvas ready");
  expect(setSourceView.mock.calls.at(-1)).toEqual([
    { reviewId: "test-session", kind: "current" },
    { reviewId: "test-session", version: 0, generation: "dirty-one" },
  ]);
  await act(async () => live.push(following(1)));
  await waitFor(() =>
    expect(setSourceView.mock.calls.at(-1)).toEqual([
      { reviewId: "test-session", kind: "current" },
      { reviewId: "test-session", version: 1, generation: "dirty-one" },
    ]),
  );
});

it("loads current map counts by generation and historical map counts by version", async () => {
  const reads: Array<{ version?: number; generation?: string }> = [];
  const loader = createDocumentLoader({
    commits: async () => [],
    resource: async () => {
      throw new Error("no resources in this document");
    },
    map: async (input) => {
      reads.push(input);
      return {
        side: "head",
        elements: [],
        relationships: [],
        countsByElementPath: {
          order: { additions: input.generation === "dirty-two" ? 2 : 1, deletions: 1 },
        },
        unmappedByElementPath: {},
      } as never;
    },
  });
  const withMap = {
    ...snapshot,
    document: [{ type: "software_map" as const, id: "map-block", mapVersionId: "map-v1" }],
  };
  try {
    const first = await loader.load(withMap, "dirty-one");
    const fresh = await loader.load(withMap, "dirty-two");
    const retained = await loader.load(withMap);
    expect(first.maps.get("map-v1")!.pinnedData.counts.get("order")).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(fresh.maps.get("map-v1")!.pinnedData.counts.get("order")).toEqual({
      additions: 2,
      deletions: 1,
    });
    expect(retained.maps.get("map-v1")!.pinnedData.counts.get("order")).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(reads.map(({ version, generation }) => ({ version, generation }))).toEqual([
      { version: 0, generation: "dirty-one" },
      { version: 0, generation: "dirty-two" },
      { version: 0, generation: undefined },
    ]);
  } finally {
    loader.dispose();
  }
});

it("applies snapshots in delivery order, skipping ones a newer answer replaced mid-load", async () => {
  const live = fakeLiveRead<unknown>();
  canvas.live = live;
  const commitReads: Array<() => void> = [];
  canvas.rpc = {
    commits: () => new Promise<never[]>((resolve) => commitReads.push(() => resolve([]))),
    progress: async () => ({ files: [], lenses: [], resolvedSelections: {} }),
  };
  // Each version pins a new head, so its document loads its own commits.
  const at = (version: number) => ({
    ...snapshot,
    version,
    source: { ...snapshot.source!, pins: { ...snapshot.source!.pins, head: `h${version}` } },
    activity: { workingCount: 0, expiresAt: null },
    coverageRevision: 0,
  });
  const setSourceView = vi.fn();
  render(
    <ApiCanvas
      content={{
        kind: "api",
        reviewId: snapshot.reviewId,
        bridge: testReviewBridge(),
        setSourceView,
      }}
    />,
  );
  await waitFor(() => expect(live.followers()).toBe(1));
  await act(async () => live.push(at(1)));
  await waitFor(() => expect(commitReads).toHaveLength(1));
  await act(async () => {
    live.push(at(2));
    live.push(at(3));
  });
  await act(async () => commitReads[0]!());
  await waitFor(() => expect(commitReads).toHaveLength(2));
  await act(async () => commitReads[1]!());
  await waitFor(() => expect(setSourceView).toHaveBeenCalledTimes(2));
  expect(setSourceView.mock.calls.map(([, view]) => view.version)).toEqual([1, 3]);
});

it("names a refused session, and says a dropped read is reconnecting until it answers", async () => {
  const live = fakeLiveRead<unknown>();
  canvas.live = live;
  canvas.rpc = {
    commits: async () => [],
    progress: async () => ({ files: [], lenses: [], resolvedSelections: {} }),
  };
  render(
    <ApiCanvas
      content={{ kind: "api", reviewId: snapshot.reviewId, bridge: testReviewBridge() }}
    />,
  );
  await waitFor(() => expect(live.followers()).toBe(1));
  await act(async () =>
    live.fail(new PluginRpcCallError({ code: "not_found", message: "Session not found." })),
  );
  expect(screen.getByRole("status").textContent).toBe("Session not found.");

  await act(async () =>
    live.push({
      ...snapshot,
      activity: { workingCount: 0, expiresAt: null },
      coverageRevision: 0,
    }),
  );
  await screen.findByText("Canvas ready");
  await act(async () =>
    live.fail(new PluginRpcCallError({ code: "conflict", message: "Host offline." })),
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Connection lost. Reconnecting… Host offline.",
  );
  await act(async () =>
    live.push({
      ...snapshot,
      activity: { workingCount: 0, expiresAt: null },
      coverageRevision: 0,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});
