// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "../../server/lib/vendor/review/src/review-api/store.ts";
import { ReviewApiClient } from "../../shared/vendor/review/src/review-api/client.ts";
import { ApiCanvas } from "../vendor/review/app/src/api-canvas.tsx";
import { testReviewBridge } from "../vendor/review/app/src/review-session-test-utils.tsx";

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

function mount(snapshot: Snapshot, version?: number) {
  vi.spyOn(ReviewApiClient.prototype, "follow").mockImplementation(async (_id, signal, onValue) => {
    await onValue({ ...snapshot, activity: { workingCount: 0, expiresAt: null } } as never);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const bridge = testReviewBridge(
    {},
    {
      request: async (value) => {
        const url = new URL(String(value));
        if (url.pathname.endsWith("/commits") || url.pathname.endsWith("/history"))
          return Response.json([]);
        if (url.pathname.endsWith("/progress"))
          return Response.json({ complete: true, files: [], lenses: [], resolvedSelections: {} });
        if (url.pathname.endsWith("/agent-traces"))
          return Response.json({ ok: true, configured: false, sessions: [], sources: [] });
        return Response.json(snapshot);
      },
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
        target: { kind: "worktree", repositoryId: "r" },
        pins: {
          repositoryId: "r",
          base: "same-head",
          head: "same-head",
          worktreeRevision: "retained-dirty-tree",
        },
        document: [],
        createdAt: "2026-09-17",
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
    target: { kind: "commits", repositoryId: "r", base: "base", head: "head" },
    pins: { repositoryId: "r", base: "base", head: "head" },
    document: [],
    createdAt: "2026-09-17",
  });
  fireEvent.click(await screen.findByRole("button", { name: "Diff" }));
  expect(container.querySelector(".review-diff-view")?.getAttribute("aria-hidden")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Commits" }));
  expect(screen.getByRole("button", { name: "Commits" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("0 commits").tagName).toBe("STRONG");
});
