import { afterEach, expect, it, vi } from "vitest";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { ReviewApiSummary } from "../../shared/vendor/review-protocol/src/index.ts";
import { SETTLE_LIMIT_MS, createCatalogEdits } from "./catalog.ts";

const key = ["whiteboard", "catalog", "optimistic-test"];
const row = (reviewId: string, dismissedAt: string | null = null): ReviewApiSummary => ({
  reviewId,
  dismissedAt,
  title: reviewId,
  version: 1,
  createdAt: "2026-10-19T00:00:00Z",
  repositoryName: "repo",
  viewedAt: null,
});
const read = () => pluginQueryClient.getQueryData<ReviewApiSummary[]>(key)!;
const gate = () => {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
};
afterEach(() => {
  vi.useRealTimers();
  pluginQueryClient.removeQueries({ queryKey: key });
});

it("shows a fast restore immediately, sends it after dismissal, and outlasts stale snapshots", async () => {
  const catalog = createCatalogEdits(key);
  catalog.receive([row("a")]);
  const dismissal = gate();
  const calls: string[] = [];
  const dismiss = catalog.command("a", "dismiss", () => {
    calls.push("dismiss");
    return dismissal.promise;
  });
  expect(read()[0]?.dismissedAt).toBeTruthy();
  const restore = catalog.command("a", "restore", async () => {
    calls.push("restore");
  });
  expect(read()[0]?.dismissedAt).toBeNull();
  await Promise.resolve();
  expect(calls).toEqual(["dismiss"]);
  catalog.receive([row("a", "2026-10-19T00:00:01Z")]);
  expect(read()[0]?.dismissedAt).toBeNull();
  dismissal.open();
  await Promise.all([dismiss, restore]);
  expect(calls).toEqual(["dismiss", "restore"]);
  // A read that started between the two writes lands after both.
  catalog.receive([row("a", "2026-10-19T00:00:01Z")]);
  expect(read()[0]?.dismissedAt).toBeNull();
  // A snapshot that agrees reconciles; then another device's change shows at once.
  catalog.receive([row("a")]);
  catalog.receive([row("a", "2026-10-19T00:00:02Z")]);
  expect(read()[0]?.dismissedAt).toBe("2026-10-19T00:00:02Z");
});

it("keeps a successful dismissal over a delayed snapshot until one agrees", async () => {
  const catalog = createCatalogEdits(key);
  catalog.receive([row("a")]);
  await catalog.command("a", "dismiss", async () => {});
  // Its read started before the POST completed.
  catalog.receive([row("a")]);
  expect(read()[0]?.dismissedAt).toBeTruthy();
  catalog.receive([row("a", "2026-10-19T00:00:03Z")]);
  expect(read()[0]?.dismissedAt).toBe("2026-10-19T00:00:03Z");
  catalog.receive([row("a")]);
  expect(read()[0]?.dismissedAt).toBeNull();
});

it("shows another device's conflicting change once a dismissal's settle limit passes", async () => {
  vi.useFakeTimers();
  const catalog = createCatalogEdits(key);
  catalog.receive([row("a")]);
  await catalog.command("a", "dismiss", async () => {});
  catalog.receive([row("a")]);
  vi.advanceTimersByTime(SETTLE_LIMIT_MS - 1);
  expect(read()[0]?.dismissedAt).toBeTruthy();
  vi.advanceTimersByTime(1);
  expect(read()[0]?.dismissedAt).toBeNull();
});

it("keeps a deleted row hidden from delayed snapshots until one omits it", async () => {
  vi.useFakeTimers();
  const catalog = createCatalogEdits(key);
  catalog.receive([row("a"), row("b")]);
  await catalog.command("a", "delete", async () => {});
  catalog.receive([row("a"), row("b")]);
  vi.advanceTimersByTime(10 * SETTLE_LIMIT_MS);
  catalog.receive([row("a"), row("b")]);
  expect(read().map((entry) => entry.reviewId)).toEqual(["b"]);
  catalog.receive([row("b"), row("c")]);
  expect(read().map((entry) => entry.reviewId)).toEqual(["b", "c"]);
});

it("rolls back only the failed row while retaining another row's live update", async () => {
  const catalog = createCatalogEdits(key);
  catalog.receive([row("a"), row("b")]);
  const deletion = gate();
  const deleting = catalog.command("a", "delete", () => deletion.promise);
  expect(read().map((entry) => entry.reviewId)).toEqual(["b"]);
  // A return visit shares pending edits rather than treating optimistic rows as server truth.
  const returnedHome = createCatalogEdits(key);
  expect(returnedHome).toBe(catalog);
  returnedHome.receive([row("a"), { ...row("b"), title: "Remote edit" }]);
  await Promise.resolve();
  deletion.fail(new Error("offline"));
  await expect(deleting).rejects.toThrow("offline");
  expect(read().map((entry) => entry.title)).toEqual(["a", "Remote edit"]);
});

it("resolves a failed command that a queued command for the row supersedes", async () => {
  const catalog = createCatalogEdits(key);
  catalog.receive([row("a")]);
  const dismissal = gate();
  const dismiss = catalog.command("a", "dismiss", () => dismissal.promise);
  const restore = catalog.command("a", "restore", async () => {});
  dismissal.fail(new Error("offline"));
  await expect(dismiss).resolves.toBeUndefined();
  await restore;
  expect(read()[0]?.dismissedAt).toBeNull();
  // Without a later command, a failure still rejects.
  const failed = catalog.command("a", "dismiss", async () => {
    throw new Error("offline");
  });
  await expect(failed).rejects.toThrow("offline");
  expect(read()[0]?.dismissedAt).toBeNull();
});
