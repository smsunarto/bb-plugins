import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread, PluginSidebarThreadsState } from "@get-bb/plugin-sdk/app";
import {
  isShelvedThread,
  isWithinSettledWindow,
  needsOlderArchivePage,
  SETTLED_WINDOW_MS,
} from "../lib/settled-threads.ts";

const now = 10 * SETTLED_WINDOW_MS;

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    displayTitle: "A thread",
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    pinnedAt: null,
    pinSortKey: null,
    archivedAt: null,
    href: "",
    isHidden: false,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

function settled(id: string, archivedAt: number): PluginSidebarThread {
  return thread({ id, isArchived: true, archivedAt });
}

function archive(
  overrides: Partial<NonNullable<PluginSidebarThreadsState["experimental_archived"]>> = {},
): NonNullable<PluginSidebarThreadsState["experimental_archived"]> {
  return {
    status: "ready",
    hasNextPage: true,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: async () => {},
    ...overrides,
  };
}

describe("isWithinSettledWindow", () => {
  it("keeps an archive from inside the window", () => {
    assert.equal(isWithinSettledWindow(now - 1, now), true);
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS + 1, now), true);
  });

  // The archive stays; only the drawing stops.
  it("drops an archive older than the window", () => {
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS, now), false);
    assert.equal(isWithinSettledWindow(now - SETTLED_WINDOW_MS - 1, now), false);
  });

  // A clock that moved must not swallow a settle the user just made.
  it("keeps an archive stamped in the future", () => {
    assert.equal(isWithinSettledWindow(now + SETTLED_WINDOW_MS, now), true);
  });

  it("is a day by default", () => {
    assert.equal(SETTLED_WINDOW_MS, 24 * 60 * 60 * 1000);
  });
});

describe("isShelvedThread", () => {
  it("keeps every active thread", () => {
    assert.equal(isShelvedThread(thread(), now), true);
    assert.equal(isShelvedThread(thread({ archivedAt: 1 }), now), true);
  });

  it("keeps a settle inside the window and drops an older one", () => {
    assert.equal(isShelvedThread(settled("recent", now - 1), now), true);
    assert.equal(isShelvedThread(settled("old", now - SETTLED_WINDOW_MS), now), false);
  });

  it("drops an archived thread bb reports without a stamp", () => {
    assert.equal(isShelvedThread(thread({ isArchived: true, archivedAt: null }), now), false);
  });
});

describe("needsOlderArchivePage", () => {
  it("asks for more while every loaded archive is still on the shelf", () => {
    assert.equal(needsOlderArchivePage([thread(), settled("a", now - 1)], archive(), now), true);
    assert.equal(needsOlderArchivePage([thread()], archive(), now), true);
  });

  it("stops once an archive older than the window has been seen", () => {
    const threads = [settled("a", now - 1), settled("b", now - SETTLED_WINDOW_MS)];
    assert.equal(needsOlderArchivePage(threads, archive(), now), false);
  });

  it("stops at the end of the archive", () => {
    assert.equal(needsOlderArchivePage([], archive({ hasNextPage: false }), now), false);
  });

  it("leaves a page in flight, a failed page, and a loading list alone", () => {
    assert.equal(needsOlderArchivePage([], archive({ isFetchingNextPage: true }), now), false);
    assert.equal(needsOlderArchivePage([], archive({ isFetchNextPageError: true }), now), false);
    assert.equal(needsOlderArchivePage([], archive({ status: "loading" }), now), false);
    assert.equal(needsOlderArchivePage([], archive({ status: "error" }), now), false);
  });

  it("does nothing when the archive was not requested", () => {
    assert.equal(needsOlderArchivePage([settled("a", now - 1)], null, now), false);
  });
});
