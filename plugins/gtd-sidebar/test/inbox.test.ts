import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  activeSectionFor,
  childrenOf,
  filterByProject,
  hideChildrenOfVisibleParents,
  nextThreadIdAfterSettle,
  parentOf,
  partitionActiveSections,
  partitionPinned,
  searchThreadsByTitle,
  sortByLatestAttentionDescending,
  sortByUpdatedAtDescending,
  threadDisplayTitle,
  visibleInboxThreads,
} from "../lib/inbox.ts";

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
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

describe("sortByLatestAttentionDescending", () => {
  it("puts the thread that last needed the user first", () => {
    const ordered = sortByLatestAttentionDescending([
      thread({ id: "a", latestAttentionAt: 1 }),
      thread({ id: "b", latestAttentionAt: 3 }),
      thread({ id: "c", latestAttentionAt: 2 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["b", "c", "a"],
    );
  });

  it("uses creation time, then id, for stable ties", () => {
    const ordered = sortByLatestAttentionDescending([
      thread({ id: "b", createdAt: 1, latestAttentionAt: 5 }),
      thread({ id: "c", createdAt: 2, latestAttentionAt: 5 }),
      thread({ id: "a", createdAt: 1, latestAttentionAt: 5 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["c", "a", "b"],
    );
  });

  it("ignores updatedAt, which a rename moves and attention does not", () => {
    const ordered = sortByLatestAttentionDescending([
      thread({ id: "renamed", latestAttentionAt: 1, updatedAt: 9 }),
      thread({ id: "worked", latestAttentionAt: 5, updatedAt: 5 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["worked", "renamed"],
    );
  });

  it("does not mutate its input", () => {
    const input = [
      thread({ id: "a", latestAttentionAt: 1 }),
      thread({ id: "b", latestAttentionAt: 2 }),
    ];
    sortByLatestAttentionDescending(input);
    assert.deepEqual(
      input.map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("sortByUpdatedAtDescending", () => {
  it("puts the most recently written row first, ignoring attention", () => {
    const ordered = sortByUpdatedAtDescending([
      thread({ id: "a", updatedAt: 1, latestAttentionAt: 9 }),
      thread({ id: "b", updatedAt: 3, latestAttentionAt: 1 }),
      thread({ id: "c", updatedAt: 2, latestAttentionAt: 5 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["b", "c", "a"],
    );
  });

  it("uses creation time, then id, for stable ties", () => {
    const ordered = sortByUpdatedAtDescending([
      thread({ id: "b", createdAt: 1, updatedAt: 5 }),
      thread({ id: "c", createdAt: 2, updatedAt: 5 }),
      thread({ id: "a", createdAt: 1, updatedAt: 5 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["c", "a", "b"],
    );
  });
});

describe("active sections", () => {
  it("puts quiet work with the user and live work in waiting", () => {
    assert.equal(activeSectionFor(thread()), "next-action");
    assert.equal(activeSectionFor(thread({ indicator: "runtime" })), "waiting");
    assert.equal(
      activeSectionFor(
        thread({
          activity: {
            workflows: 0,
            backgroundAgents: 0,
            backgroundCommands: 1,
            planMode: 0,
            goals: 0,
          },
        }),
      ),
      "waiting",
    );
  });

  it("puts a pending interaction in next action even with live work", () => {
    assert.equal(
      activeSectionFor(
        thread({
          hasPendingInteraction: true,
          activity: {
            workflows: 1,
            backgroundAgents: 0,
            backgroundCommands: 0,
            planMode: 0,
            goals: 0,
          },
        }),
      ),
      "next-action",
    );
  });

  it("sorts next action by attention and waiting by the last row write", () => {
    // Every thread carries both clocks, disagreeing, so each section can only
    // pass by reading the one it is supposed to read.
    const threads = [
      thread({ id: "quiet-old", latestAttentionAt: 10, updatedAt: 40 }),
      thread({ id: "quiet-new", latestAttentionAt: 20, updatedAt: 30 }),
      thread({
        id: "started-first",
        latestAttentionAt: 40,
        updatedAt: 10,
        indicator: "runtime",
      }),
      thread({
        id: "started-last",
        latestAttentionAt: 30,
        updatedAt: 20,
        indicator: "runtime",
      }),
    ];
    const sections = partitionActiveSections(threads);
    assert.deepEqual(
      sections.nextAction.map((candidate) => candidate.id),
      ["quiet-new", "quiet-old"],
    );
    assert.deepEqual(
      sections.waiting.map((candidate) => candidate.id),
      ["started-last", "started-first"],
    );
  });
});

describe("threadDisplayTitle", () => {
  it("prefers the title, then the fallback, then a placeholder", () => {
    assert.equal(threadDisplayTitle(thread({ title: "Real" })), "Real");
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: "Fallback" })),
      "Fallback",
    );
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: null })),
      "Untitled thread",
    );
  });

  it("treats a whitespace-only title as absent", () => {
    assert.equal(
      threadDisplayTitle(thread({ title: "   ", titleFallback: "Fallback" })),
      "Fallback",
    );
  });
});

describe("searchThreadsByTitle", () => {
  it("matches case-insensitively on the visible title", () => {
    const threads = [
      thread({ id: "a", title: "Sidebar work" }),
      thread({ id: "b", title: "Something else" }),
      thread({ id: "c", title: null, titleFallback: "sidebar fallback" }),
    ];
    assert.deepEqual(
      searchThreadsByTitle(threads, "SIDEBAR").map((t) => t.id),
      ["a", "c"],
    );
  });

  it("returns everything for a blank query", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b" })];
    assert.equal(searchThreadsByTitle(threads, "   ").length, 2);
  });
});

describe("filtering", () => {
  it("scopes to one project, or to all", () => {
    const threads = [thread({ id: "a", projectId: "p1" }), thread({ id: "b", projectId: "p2" })];
    assert.deepEqual(
      filterByProject(threads, "p1").map((t) => t.id),
      ["a"],
    );
    assert.equal(filterByProject(threads, null).length, 2);
  });

  it("drops archived threads", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b", isArchived: true })];
    assert.deepEqual(
      visibleInboxThreads(threads, new Set()).map((t) => t.id),
      ["a"],
    );
  });

  // Settling archives the thread in bb, so the archive flag alone would empty
  // the settled shelf the moment anything landed on it.
  it("keeps an archived thread the plugin parked", () => {
    const threads = [thread({ id: "a", isArchived: true }), thread({ id: "b", isArchived: true })];
    assert.deepEqual(
      visibleInboxThreads(threads, new Set(["a"])).map((t) => t.id),
      ["a"],
    );
  });

  it("splits pinned from the rest, keeping order", () => {
    const { pinned, inbox } = partitionPinned([
      thread({ id: "a" }),
      thread({ id: "b", isPinned: true }),
      thread({ id: "c" }),
    ]);
    assert.deepEqual(
      pinned.map((t) => t.id),
      ["b"],
    );
    assert.deepEqual(
      inbox.map((t) => t.id),
      ["a", "c"],
    );
  });
});

describe("nextThreadIdAfterSettle", () => {
  const section = [thread({ id: "a" }), thread({ id: "b" }), thread({ id: "c" })];

  it("moves a focused thread to the row below it", () => {
    assert.equal(nextThreadIdAfterSettle(section, "b", "b"), "c");
  });

  it("falls back to the row above when settling the final row", () => {
    assert.equal(nextThreadIdAfterSettle(section, "c", "c"), "b");
  });

  it("does not move focus when settling an unfocused thread", () => {
    assert.equal(nextThreadIdAfterSettle(section, "b", "a"), null);
  });

  it("returns no target when the section has no adjacent row", () => {
    assert.equal(nextThreadIdAfterSettle([thread({ id: "only" })], "only", "only"), null);
  });
});

describe("child threads", () => {
  it("hides a child whose parent is on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent" }),
    ]);
    assert.deepEqual(
      visible.map((t) => t.id),
      ["parent"],
    );
  });

  // An orphan must stay visible: hidden here AND absent from any header chip
  // would make it unreachable everywhere.
  it("keeps a child whose parent is not on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "child", parentThreadId: "archived-parent" }),
    ]);
    assert.deepEqual(
      visible.map((t) => t.id),
      ["child"],
    );
  });

  it("lists a thread's children oldest first", () => {
    const children = childrenOf(
      [
        thread({ id: "parent" }),
        thread({ id: "b", parentThreadId: "parent", createdAt: 20 }),
        thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
        thread({ id: "other", parentThreadId: "elsewhere" }),
      ],
      "parent",
    );
    assert.deepEqual(
      children.map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("parentOf", () => {
  // The list hides an archived parent, but the child's header must still get
  // it back — otherwise the child is a dead end.
  it("finds a parent the inbox filters out", () => {
    const parent = parentOf(
      [
        thread({ id: "parent", isArchived: true, projectId: "other" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    assert.equal(parent?.id, "parent");
  });

  it("returns null for a root thread", () => {
    assert.equal(parentOf([thread({ id: "root" })], "root"), null);
  });

  it("returns null when the parent row is gone", () => {
    const threads = [thread({ id: "child", parentThreadId: "deleted" })];
    assert.equal(parentOf(threads, "child"), null);
  });
});
