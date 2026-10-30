import { randomUUID } from "node:crypto";
import { DatabaseSync } from "../sqlite-testing.ts";

import { afterEach, expect, it, vi } from "vitest";

import { ACTIVITY_TTL_MS, ReviewActivity } from "./activity.ts";
import { createReviewApi } from "./api.ts";
import { LocalReviewData } from "./local-data.ts";
import { ReviewStore } from "./store.ts";

const databases: DatabaseSync[] = [];

const newActivity = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);

  return new ReviewActivity(db);
};

afterEach(() => {
  vi.useRealTimers();

  for (const db of databases.splice(0)) db.close();
});

it("renews reported work, expires abandoned work, and does not end another author's activity", () => {
  vi.useFakeTimers();
  const activity = newActivity();
  const notify = vi.fn<Parameters<ReviewActivity["subscribe"]>[0]>();
  activity.subscribe(notify);

  const a = randomUUID(),
    b = randomUUID();

  const update = (leaseId: string, action: "begin" | "renew" | "end") =>
    activity.update("review", { leaseId, action });

  expect(update(a, "begin").workingCount).toBe(1);
  expect(update(a, "begin").workingCount).toBe(1);
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  update(a, "renew");
  expect(() => update(b, "begin")).toThrow(/another session/);
  expect(update(b, "end").workingCount).toBe(1);
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  expect(activity.read("review").workingCount).toBe(1);
  expect(update(a, "end").workingCount).toBe(0);
  expect(update(a, "end").workingCount).toBe(0);
  update(b, "begin");
  vi.advanceTimersByTime(ACTIVITY_TTL_MS);
  expect(activity.read("review")).toEqual({ workingCount: 0, expiresAt: null });
  expect(notify).toHaveBeenLastCalledWith("review");
  expect(() => update(b, "renew")).toThrow(/expired/);
  activity.update("another", { leaseId: randomUUID(), action: "begin" });
  expect(activity.read("review").workingCount).toBe(0);
  activity.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports activity beside the live document without versioning it, and refuses it once deleted", async () => {
  const store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const api = createReviewApi({ store, data: new LocalReviewData(store) });

  const command = <Operation>(operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation });

  const { reviewId } = await command({
    type: "create",
    source: "pins",
    title: "Activity",
    pins: { repositoryId: "repo", base: "base", head: "head" },
  });

  const changed = vi.fn<Parameters<ReviewStore["subscribe"]>[0]>();
  store.subscribe(changed);
  const activityChanged = vi.fn<Parameters<ReviewStore["activity"]["subscribe"]>[0]>();
  store.activity.subscribe(activityChanged);

  try {
    expect(await api.liveSession({ reviewId })).toMatchObject({
      activity: { workingCount: 0 },
    });

    const input = {
      action: "begin" as const,
      leaseId: randomUUID(),
      focus: { description: "Drafting outline" },
    };

    await api.activity({ reviewId, ...input });
    expect(activityChanged).toHaveBeenCalledWith(reviewId);
    expect(await api.liveSession({ reviewId })).toMatchObject({
      version: 0,
      activity: { workingCount: 1, focuses: [input.focus] },
    });
    expect(changed).not.toHaveBeenCalled();
    expect(store.history(reviewId)).toHaveLength(1);
    await store.execute({
      commandId: randomUUID(),
      leaseId: input.leaseId,
      operation: { type: "delete", reviewId },
    });
    await expect(api.liveSession({ reviewId })).rejects.toMatchObject({ status: 404 });
    await expect(api.activity({ reviewId, ...input })).rejects.toThrow(/not found/i);
    expect(store.activity.read(reviewId).workingCount).toBe(0);
  } finally {
    await store.close();
  }
});

it("retains, changes and clears the owner's focus until its lease expires", () => {
  vi.useFakeTimers();
  const activity = newActivity();
  const leaseId = randomUUID();
  const other = randomUUID();
  const focus = { description: "Adding evidence", targetId: "section-1" };
  activity.update("review", { action: "begin", leaseId, focus });
  expect(activity.update("review", { action: "renew", leaseId }).focuses).toEqual([focus]);
  expect(() =>
    activity.update("review", {
      action: "begin",
      leaseId: other,
      focus: { description: "Drafting summary" },
    }),
  ).toThrow(/another session/);
  const next = { description: "Drawing save flow", targetId: "section-2" };
  expect(activity.update("review", { action: "renew", leaseId, focus: next }).focuses).toEqual([
    next,
  ]);
  expect(
    activity.update("review", { action: "renew", leaseId, focus: null }).focuses,
  ).toBeUndefined();
  activity.update("review", { action: "end", leaseId: other });
  expect(activity.read("review").focuses).toBeUndefined();
  activity.update("review", { action: "renew", leaseId, focus });
  vi.advanceTimersByTime(ACTIVITY_TTL_MS);
  expect(activity.read("review").focuses).toBeUndefined();
  activity.close();
});
