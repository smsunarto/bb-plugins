import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { buildInboxTree, visibleInboxRows, type InboxShelf } from "../lib/inbox-tree.ts";
import { groupRowsByBot } from "../bots/lib/bot-groups.ts";

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    projectId: "one",
    title: id,
    titleFallback: null,
    parentNotifications: "auto",
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
    displayTitle: id,
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

const owners = new Map([
  ["atlas-1", "atlas"],
  ["atlas-2", "atlas"],
  ["atlas-child", "atlas"],
  ["pinned-bot", "atlas"],
  ["nova-1", "nova"],
]);
const botOf = (threadId: string) => owners.get(threadId) ?? null;

function shelfOf(threads: PluginSidebarThread[]): Map<string, InboxShelf> {
  return new Map(
    buildInboxTree(threads, () => "active", "", { botOf }).map((node) => [
      node.thread.id,
      node.shelf,
    ]),
  );
}

function botRows(threads: PluginSidebarThread[]) {
  const tree = buildInboxTree(threads, () => "active", "", { botOf }).filter(
    (node) => node.shelf === "bots",
  );
  return visibleInboxRows(tree, new Set());
}

describe("the Bots shelf", () => {
  it("takes a bot's waiting and next-action families, leaving pins and other threads", () => {
    const shelves = shelfOf([
      thread("atlas-1"),
      thread("atlas-2", { indicator: "runtime" }),
      thread("pinned-bot", { isPinned: true }),
      thread("mine"),
    ]);
    assert.equal(shelves.get("atlas-1"), "bots");
    assert.equal(shelves.get("atlas-2"), "bots");
    assert.equal(shelves.get("pinned-bot"), "pinned");
    assert.equal(shelves.get("mine"), "nextAction");
  });

  it("groups rows per shown bot in saved order and keeps a bot with no conversations", () => {
    const rows = botRows([
      thread("atlas-1"),
      thread("atlas-child", { parentThreadId: "atlas-1" }),
      thread("nova-1"),
    ]);
    const groups = groupRowsByBot(rows, {
      botIds: ["nova", "atlas", "empty"],
      ownerOf: botOf,
      isCompleted: () => false,
      showCompleted: new Set(),
      activeThreadId: null,
    });
    assert.deepEqual(
      groups.map((group) => [group.projectId, group.rows.map((row) => row.node.thread.id)]),
      [
        ["nova", ["nova-1"]],
        ["atlas", ["atlas-1", "atlas-child"]],
        ["empty", []],
      ],
    );
    assert.equal(groups[1]!.families, 1);
  });

  it("folds a completed family behind its count unless shown or open", () => {
    const rows = botRows([
      thread("atlas-1"),
      thread("atlas-child", { parentThreadId: "atlas-1" }),
      thread("atlas-2"),
    ]);
    const done = new Set(["atlas-1", "atlas-child"]);
    const grouping = {
      botIds: ["atlas"],
      ownerOf: botOf,
      isCompleted: (threadId: string) => done.has(threadId),
      showCompleted: new Set<string>(),
      activeThreadId: null as string | null,
    };
    const folded = groupRowsByBot(rows, grouping)[0]!;
    assert.deepEqual(
      folded.rows.map((row) => row.node.thread.id),
      ["atlas-2"],
    );
    assert.equal(folded.completed, 1);

    const opened = groupRowsByBot(rows, { ...grouping, activeThreadId: "atlas-child" })[0]!;
    assert.equal(opened.completed, 0);
    assert.equal(opened.rows.length, 3);

    const shown = groupRowsByBot(rows, { ...grouping, showCompleted: new Set(["atlas"]) })[0]!;
    assert.equal(shown.rows.length, 3);
  });

  it("keeps a completed conversation on screen while a child still needs showing", () => {
    const rows = botRows([
      thread("atlas-1"),
      thread("atlas-child", { parentThreadId: "atlas-1", hasPendingInteraction: true }),
    ]);
    const group = groupRowsByBot(rows, {
      botIds: ["atlas"],
      ownerOf: botOf,
      isCompleted: (threadId) => threadId === "atlas-1",
      showCompleted: new Set(),
      activeThreadId: null,
    })[0]!;
    assert.deepEqual(
      group.rows.map((row) => row.node.thread.id),
      ["atlas-1", "atlas-child"],
    );
    assert.equal(group.completed, 0);
  });

  it("folds a completed child alone under an open conversation", () => {
    const rows = botRows([thread("atlas-1"), thread("atlas-child", { parentThreadId: "atlas-1" })]);
    const group = groupRowsByBot(rows, {
      botIds: ["atlas"],
      ownerOf: botOf,
      isCompleted: (threadId) => threadId === "atlas-child",
      showCompleted: new Set(),
      activeThreadId: null,
    })[0]!;
    assert.deepEqual(
      group.rows.map((row) => row.node.thread.id),
      ["atlas-1"],
    );
    assert.equal(group.families, 1);
    assert.equal(group.completed, 1);
  });

  it("moves a child to its own family when its bot differs from its parent's", () => {
    const owned = new Map([
      ["atlas-1", "atlas"],
      ["to-nova", "nova"],
      ["mine", null],
      ["to-atlas", "atlas"],
    ]);
    const tree = buildInboxTree(
      [
        thread("atlas-1"),
        thread("to-nova", { parentThreadId: "atlas-1" }),
        thread("detached", { parentThreadId: "atlas-1" }),
        thread("mine"),
        thread("to-atlas", { parentThreadId: "mine" }),
      ],
      () => "active",
      "",
      { botOf: (threadId) => owned.get(threadId) ?? null },
    );
    const roots = new Map(tree.map((node) => [node.thread.id, node]));
    assert.equal(roots.get("to-nova")?.shelf, "bots");
    assert.equal(roots.get("to-atlas")?.shelf, "bots");
    assert.equal(roots.get("detached")?.shelf, "nextAction");
    assert.deepEqual(roots.get("atlas-1")?.children, []);
    assert.deepEqual(roots.get("mine")?.children, []);
  });

  it("drops a hidden bot's rows with the bot", () => {
    const rows = botRows([thread("atlas-1"), thread("nova-1")]);
    const groups = groupRowsByBot(rows, {
      botIds: ["nova"],
      ownerOf: botOf,
      isCompleted: () => false,
      showCompleted: new Set(),
      activeThreadId: null,
    });
    assert.deepEqual(
      groups.flatMap((group) => group.rows.map((row) => row.node.thread.id)),
      ["nova-1"],
    );
  });
});
