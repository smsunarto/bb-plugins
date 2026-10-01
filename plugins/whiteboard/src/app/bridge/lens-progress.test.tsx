// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ReviewProgress } from "../../server/lib/vendor/review/src/review-api/review-progress.ts";
import type { Snapshot } from "../../server/lib/vendor/review/src/review-api/store.ts";
import { ReviewApiClient } from "../../shared/vendor/review/src/review-api/client.ts";
import { ReviewDiffView } from "../vendor/review/app/src/DiffView.tsx";
import { ReviewSessionProvider } from "../vendor/review/app/src/host/review-session.tsx";
import { ReviewLensesProvider } from "../vendor/review/app/src/review-lenses.tsx";
import { testReviewSession } from "../vendor/review/app/src/review-session-test-utils.tsx";

afterEach(cleanup);

it("marks a lens's base and head ranges, preserves other changed lines and reloads the mark", async () => {
  const sources = [
    { side: "base" as const, file: "order.ts", fromLine: 2, toLine: 2 },
    { side: "head" as const, file: "order.ts", fromLine: 2, toLine: 2 },
  ];
  let progress: ReviewProgress = {
    complete: true,
    files: [
      {
        path: "order.ts",
        fingerprint: "file-fingerprint",
        changed: { base: [[0, 3]], head: [[0, 3]] },
        viewed: { base: [], head: [] },
      },
    ],
    resolvedSelections: {},
    lenses: [{ id: "queued", title: "Queued status range", sources, fileCount: 1 }],
  };
  const updates: unknown[] = [];
  const session = testReviewSession(
    {},
    {
      request: async (_url, init) => {
        if (init?.method === "POST") {
          const update = JSON.parse(String(init.body));
          updates.push(update);
          progress = {
            ...progress,
            files: progress.files.map((file) => ({
              ...file,
              viewed: update.viewed ? { base: [[1, 2]], head: [[1, 2]] } : { base: [], head: [] },
            })),
          };
        }
        return Response.json(progress);
      },
      diffView: {
        files: async () => [],
        create: () => ({
          focus() {},
          dispose() {},
          onDidError: () => ({ dispose() {} }),
        }),
      },
    },
  );
  const client = new ReviewApiClient(session.config, session.bridge.request);
  const snapshot: Snapshot = {
    reviewId: "test-session",
    version: 0,
    title: "Order",
    target: { kind: "commits", repositoryId: "r", base: "b", head: "h" },
    pins: { repositoryId: "r", base: "b", head: "h" },
    document: [],
    createdAt: "2026-09-17",
  };
  const ui = (
    <ReviewSessionProvider session={session}>
      <ReviewLensesProvider client={client} snapshot={snapshot}>
        <ReviewDiffView />
      </ReviewLensesProvider>
    </ReviewSessionProvider>
  );
  const first = render(ui);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Mark viewed: Queued status range" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: "Mark unviewed: Queued status range" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(
    screen.getByRole("progressbar", { name: "Changed lines viewed" }).getAttribute("aria-valuenow"),
  ).toBe("33");
  expect(updates).toEqual([
    {
      version: 0,
      mode: "structural",
      files: [{ path: "order.ts", fingerprint: "file-fingerprint", sources }],
      viewed: true,
    },
  ]);
  first.unmount();
  render(ui);
  const checkbox = await screen.findByRole("checkbox", {
    name: "Mark unviewed: Queued status range",
  });
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: "Mark viewed: Queued status range" })
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  expect(
    screen.getByRole("progressbar", { name: "Changed lines viewed" }).getAttribute("aria-valuenow"),
  ).toBe("0");
  expect(updates[1]).toEqual({
    version: 0,
    mode: "structural",
    files: [{ path: "order.ts", fingerprint: "file-fingerprint", sources }],
    viewed: false,
  });
});

it("refreshes current progress on generation changes without a version bump and retains historical progress", async () => {
  const reads: URL[] = [];
  const session = testReviewSession(
    {},
    {
      request: async (url) => {
        const parsed = new URL(String(url));
        reads.push(parsed);
        const fresh = parsed.searchParams.get("generation") === "dirty-two";
        return Response.json({
          complete: true,
          files: [
            {
              path: "order.ts",
              fingerprint: fresh ? "new-file" : "old-file",
              changed: { base: [[0, fresh ? 2 : 1]], head: [[0, fresh ? 2 : 1]] },
              viewed: fresh ? { base: [], head: [] } : { base: [[0, 1]], head: [[0, 1]] },
            },
          ],
          resolvedSelections: {},
          lenses: [],
        });
      },
      diffView: {
        files: async () => [],
        create: () => ({ focus() {}, dispose() {}, onDidError: () => ({ dispose() {} }) }),
      },
    },
  );
  const client = new ReviewApiClient(session.config, session.bridge.request);
  const snapshot: Snapshot = {
    reviewId: "test-session",
    version: 0,
    title: "Order",
    target: { kind: "worktree", repositoryId: "r" },
    pins: { repositoryId: "r", base: "b", head: "h", worktreeRevision: "dirty-one" },
    document: [],
    createdAt: "2026-09-17",
  };
  const ui = (value: Snapshot, generation?: string) => (
    <ReviewSessionProvider session={session}>
      <ReviewLensesProvider client={client} snapshot={value} sourceGeneration={generation}>
        <ReviewDiffView />
      </ReviewLensesProvider>
    </ReviewSessionProvider>
  );
  const rendered = render(ui(snapshot, "dirty-one"));
  await waitFor(() =>
    expect(
      screen
        .getByRole("progressbar", { name: "Changed lines viewed" })
        .getAttribute("aria-valuenow"),
    ).toBe("100"),
  );
  rendered.rerender(
    ui({ ...snapshot, pins: { ...snapshot.pins!, worktreeRevision: "dirty-two" } }, "dirty-two"),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("progressbar", { name: "Changed lines viewed" })
        .getAttribute("aria-valuenow"),
    ).toBe("0"),
  );
  rendered.rerender(ui(snapshot));
  await waitFor(() =>
    expect(
      screen
        .getByRole("progressbar", { name: "Changed lines viewed" })
        .getAttribute("aria-valuenow"),
    ).toBe("100"),
  );
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
});
