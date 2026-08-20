import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  activeSectionFor,
  childrenOf,
  filterByProject,
  groupIntoFamilies,
  parentOf,
  partitionActiveSections,
  partitionPinned,
  reconcileActiveSectionOrder,
  searchThreadsByTitle,
  sortByCreatedAtDescending,
  threadDisplayTitle,
  visibleInboxThreads,
} from "../lib/inbox.ts";
import { isThreadWorking, rollUpSignals, type ThreadActivitySignals } from "../lib/lifecycle.ts";

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

function signalsFor(candidate: PluginSidebarThread): ThreadActivitySignals {
  return {
    hasPendingInteraction: candidate.hasPendingInteraction,
    isWorking: isThreadWorking(candidate),
    isUnread: candidate.isUnread,
    latestAttentionAt: candidate.latestAttentionAt,
  };
}

const sectionForThread = (candidate: PluginSidebarThread) =>
  activeSectionFor(signalsFor(candidate));

describe("sortByCreatedAtDescending", () => {
  it("puts the newest thread first", () => {
    const ordered = sortByCreatedAtDescending([
      thread({ id: "a", createdAt: 1 }),
      thread({ id: "b", createdAt: 3 }),
      thread({ id: "c", createdAt: 2 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["b", "c", "a"],
    );
  });

  // This static sort still owns pinned and settled shelves. Activity must not
  // move a row inside either one.
  it("ignores activity and update time", () => {
    const before = [
      thread({ id: "a", createdAt: 2, updatedAt: 1 }),
      thread({ id: "b", createdAt: 1, updatedAt: 999, indicator: "runtime" }),
    ];
    assert.deepEqual(
      sortByCreatedAtDescending(before).map((t) => t.id),
      ["a", "b"],
    );
  });

  it("breaks ties on id so the order is stable", () => {
    const ordered = sortByCreatedAtDescending([
      thread({ id: "b", createdAt: 5 }),
      thread({ id: "a", createdAt: 5 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["a", "b"],
    );
  });

  it("does not mutate its input", () => {
    const input = [thread({ id: "a", createdAt: 1 }), thread({ id: "b", createdAt: 2 })];
    sortByCreatedAtDescending(input);
    assert.deepEqual(
      input.map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("active sections", () => {
  it("puts quiet work with the user and live work in waiting", () => {
    assert.equal(sectionForThread(thread()), "next-action");
    assert.equal(sectionForThread(thread({ indicator: "runtime" })), "waiting");
    assert.equal(
      sectionForThread(
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
      sectionForThread(
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

  it("puts a quiet parent in waiting while a child works", () => {
    const parent = thread({ id: "parent" });
    const child = thread({ id: "child", parentThreadId: parent.id, indicator: "runtime" });
    const familySignals = rollUpSignals(signalsFor(parent), [signalsFor(child)]);
    assert.equal(activeSectionFor(familySignals), "waiting");
  });

  it("puts a parent in next action when one child asks while another works", () => {
    const parent = thread({ id: "parent" });
    const asking = thread({
      id: "asking",
      parentThreadId: parent.id,
      hasPendingInteraction: true,
    });
    const working = thread({ id: "working", parentThreadId: parent.id, indicator: "runtime" });
    const familySignals = rollUpSignals(signalsFor(parent), [
      signalsFor(asking),
      signalsFor(working),
    ]);
    assert.equal(activeSectionFor(familySignals), "next-action");
  });

  it("classifies a childless thread exactly from its own signals", () => {
    const candidate = thread({ indicator: "runtime" });
    assert.equal(
      activeSectionFor(rollUpSignals(signalsFor(candidate), [])),
      activeSectionFor(signalsFor(candidate)),
    );
  });

  it("seeds oldest first from update time, creation time, then id", () => {
    const threads = [
      thread({ id: "d", updatedAt: 30, createdAt: 1 }),
      thread({ id: "c", updatedAt: 20, createdAt: 20 }),
      thread({ id: "b", updatedAt: 20, createdAt: 10 }),
      thread({ id: "a", updatedAt: 20, createdAt: 10 }),
    ];
    const order = reconcileActiveSectionOrder(null, threads, sectionForThread);
    const sections = partitionActiveSections(threads, order, sectionForThread);
    assert.deepEqual(
      sections.nextAction.map((candidate) => candidate.id),
      ["a", "b", "c", "d"],
    );
  });

  it("does not move a thread for metadata updates within one section", () => {
    const initial = [thread({ id: "a", updatedAt: 10 }), thread({ id: "b", updatedAt: 20 })];
    const first = reconcileActiveSectionOrder(null, initial, sectionForThread);
    const updated = [thread({ id: "a", updatedAt: 999, title: "Renamed" }), initial[1]!];
    const next = reconcileActiveSectionOrder(first, updated, sectionForThread);
    assert.deepEqual(
      partitionActiveSections(updated, next, sectionForThread).nextAction.map(
        (candidate) => candidate.id,
      ),
      ["a", "b"],
    );
  });

  it("puts a section entrant at the bottom", () => {
    const initial = [
      thread({ id: "a", updatedAt: 10 }),
      thread({ id: "b", updatedAt: 20, indicator: "runtime" }),
    ];
    const first = reconcileActiveSectionOrder(null, initial, sectionForThread);
    const transitioned = [thread({ id: "a", updatedAt: 30, indicator: "runtime" }), initial[1]!];
    const next = reconcileActiveSectionOrder(first, transitioned, sectionForThread);
    assert.deepEqual(
      partitionActiveSections(transitioned, next, sectionForThread).waiting.map(
        (candidate) => candidate.id,
      ),
      ["b", "a"],
    );
  });

  it("treats a return from pinning or parking as a new entrance", () => {
    const initial = [thread({ id: "a", updatedAt: 10 }), thread({ id: "b", updatedAt: 20 })];
    const first = reconcileActiveSectionOrder(null, initial, sectionForThread);
    const withoutA = reconcileActiveSectionOrder(first, [initial[1]!], sectionForThread);
    const returned = reconcileActiveSectionOrder(withoutA, initial, sectionForThread);
    assert.deepEqual(
      partitionActiveSections(initial, returned, sectionForThread).nextAction.map(
        (candidate) => candidate.id,
      ),
      ["b", "a"],
    );
  });

  it("keeps order when presentation filters hide a tracked thread", () => {
    const threads = [
      thread({ id: "a", updatedAt: 10, projectId: "p1" }),
      thread({ id: "b", updatedAt: 20, projectId: "p2" }),
    ];
    const first = reconcileActiveSectionOrder(null, threads, sectionForThread);
    assert.deepEqual(
      partitionActiveSections(
        filterByProject(threads, "p2"),
        first,
        sectionForThread,
      ).nextAction.map((candidate) => candidate.id),
      ["b"],
    );
    const next = reconcileActiveSectionOrder(first, threads, sectionForThread);
    assert.deepEqual(
      partitionActiveSections(threads, next, sectionForThread).nextAction.map(
        (candidate) => candidate.id,
      ),
      ["a", "b"],
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

  // Legacy settled rows still arrive archived and must remain recoverable.
  it("keeps a legacy archived thread the plugin parked", () => {
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

describe("child threads", () => {
  it("flattens a grandchild onto the top ancestor", () => {
    const families = groupIntoFamilies([
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent" }),
      thread({ id: "grandchild", parentThreadId: "child" }),
    ]);
    assert.equal(families.length, 1);
    assert.equal(families[0]?.parent.id, "parent");
    assert.deepEqual(
      families[0]?.children.map((candidate) => candidate.id),
      ["child", "grandchild"],
    );
  });

  it("makes an orphan its own family parent", () => {
    const families = groupIntoFamilies([
      thread({ id: "child", parentThreadId: "archived-parent" }),
    ]);
    assert.equal(families[0]?.parent.id, "child");
    assert.deepEqual(families[0]?.children, []);
  });

  it("terminates a malformed parent cycle", () => {
    assert.doesNotThrow(() => {
      const families = groupIntoFamilies([
        thread({ id: "a", parentThreadId: "b" }),
        thread({ id: "b", parentThreadId: "a" }),
      ]);
      assert.equal(families.length, 1);
      assert.deepEqual(
        [families[0]?.parent.id, ...families[0]!.children.map((candidate) => candidate.id)].sort(),
        ["a", "b"],
      );
    });
  });

  it("keeps parent order and sorts descendants oldest first", () => {
    const families = groupIntoFamilies([
      thread({ id: "second-parent", createdAt: 40 }),
      thread({ id: "newer-child", parentThreadId: "first-parent", createdAt: 30 }),
      thread({ id: "first-parent", createdAt: 10 }),
      thread({ id: "older-child", parentThreadId: "first-parent", createdAt: 20 }),
    ]);
    assert.deepEqual(
      families.map((family) => family.parent.id),
      ["second-parent", "first-parent"],
    );
    assert.deepEqual(
      families[1]?.children.map((candidate) => candidate.id),
      ["older-child", "newer-child"],
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
