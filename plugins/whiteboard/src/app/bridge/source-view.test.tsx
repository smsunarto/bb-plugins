// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "../../server/lib/review/store.ts";
import { ReviewApiClient } from "../../shared/review/client.ts";
import { ApiCanvas } from "../review/api-canvas.tsx";
import { createDocumentLoader } from "../review/api-document.tsx";
import { testReviewBridge } from "../review/review-session-test-utils.tsx";

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
  type FollowSnapshot = LiveSnapshot & { activity: { workingCount: number; expiresAt: null } };
  let push: ((value: FollowSnapshot) => Promise<void>) | undefined;
  vi.spyOn(ReviewApiClient.prototype, "follow").mockImplementation(async (_id, signal, onValue) => {
    push = async (value) => {
      await onValue(value as never);
    };
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const bridge = testReviewBridge(
    {},
    {
      request: async (url) =>
        Response.json(
          String(url).includes("/commits?")
            ? []
            : {
                files: [],
                lenses: [],
                resolvedSelections: {},
              },
        ),
    },
  );
  const setSourceView = vi.fn();
  render(
    <ApiCanvas content={{ kind: "api", reviewId: snapshot.reviewId, bridge, setSourceView }} />,
  );
  await waitFor(() => expect(typeof push).toBe("function"));
  await act(async () => push!({ ...snapshot, activity: { workingCount: 0, expiresAt: null } }));
  await screen.findByText("Canvas ready");
  expect(setSourceView.mock.calls.at(-1)).toEqual([
    { reviewId: "test-session", kind: "current" },
    { reviewId: "test-session", version: 0, generation: "dirty-one" },
  ]);
  await act(async () =>
    push!({ ...snapshot, version: 1, activity: { workingCount: 0, expiresAt: null } }),
  );
  expect(setSourceView.mock.calls.at(-1)).toEqual([
    { reviewId: "test-session", kind: "current" },
    { reviewId: "test-session", version: 1, generation: "dirty-one" },
  ]);
});

it("loads current map counts by generation and historical map counts by version", async () => {
  const reads: URL[] = [];
  const bridge = testReviewBridge(
    {},
    {
      request: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith("/commits")) return Response.json([]);
        reads.push(parsed);
        return Response.json({
          side: "head",
          elements: [],
          relationships: [],
          countsByElementPath: {
            order: {
              additions: parsed.searchParams.get("generation") === "dirty-two" ? 2 : 1,
              deletions: 1,
            },
          },
          unmappedByElementPath: {},
        });
      },
    },
  );
  const loader = createDocumentLoader(new ReviewApiClient(bridge.config, bridge.request));
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
    expect(
      reads.map((url) => ({
        version: url.searchParams.get("version"),
        generation: url.searchParams.get("generation"),
      })),
    ).toEqual([
      { version: "0", generation: "dirty-one" },
      { version: "0", generation: "dirty-two" },
      { version: "0", generation: null },
    ]);
  } finally {
    loader.dispose();
  }
});
