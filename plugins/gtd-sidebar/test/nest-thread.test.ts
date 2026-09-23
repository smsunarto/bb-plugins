import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { buildInboxTree, nestDropAllowed, unnestDropAllowed } from "../lib/inbox-tree.ts";
import { createThreadNester } from "../lib/nest-thread.ts";

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    projectId: "one",
    title: id,
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
    displayTitle: "",
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

// root -> child -> grandchild, plus a second root and one in another project.
const roots = buildInboxTree(
  [
    thread("root"),
    thread("child", { parentThreadId: "root" }),
    thread("grandchild", { parentThreadId: "child" }),
    thread("other"),
    thread("elsewhere", { projectId: "two" }),
  ],
  () => "active",
);

describe("nestDropAllowed", () => {
  it("lets a root drop onto another root, and a leaf onto a sibling family", () => {
    assert.equal(nestDropAllowed(roots, "other", "root"), true);
    assert.equal(nestDropAllowed(roots, "grandchild", "other"), true);
  });

  it("refuses a row onto itself, its parent, or anything inside its own family", () => {
    assert.equal(nestDropAllowed(roots, "root", "root"), false);
    assert.equal(nestDropAllowed(roots, "child", "root"), false);
    assert.equal(nestDropAllowed(roots, "root", "child"), false);
    assert.equal(nestDropAllowed(roots, "root", "grandchild"), false);
  });

  it("refuses a drop across projects or onto an unknown row", () => {
    assert.equal(nestDropAllowed(roots, "other", "elsewhere"), false);
    assert.equal(nestDropAllowed(roots, "other", "missing"), false);
    assert.equal(nestDropAllowed(roots, "missing", "other"), false);
  });
});

describe("unnestDropAllowed", () => {
  it("lets a nested row drop onto its own project's header, and nothing else", () => {
    assert.equal(unnestDropAllowed(roots, "grandchild", "one"), true);
    assert.equal(unnestDropAllowed(roots, "root", "one"), false);
    assert.equal(unnestDropAllowed(roots, "child", "two"), false);
  });
});

/** bb's threads area reduced to the two calls the nester makes. */
function fakeThreads(rows: { id: string; projectId: string; parentThreadId: string | null }[]) {
  const updates: { threadId: string; parentThreadId: string | null | undefined }[] = [];
  const threads = {
    updates,
    async get({ threadId }: { threadId: string }) {
      const row = rows.find((candidate) => candidate.id === threadId);
      if (row === undefined) throw new Error(`no thread ${threadId}`);
      return row;
    },
    async update(args: { threadId: string; parentThreadId?: string | null }) {
      updates.push({ threadId: args.threadId, parentThreadId: args.parentThreadId });
      return { ok: true };
    },
  };
  return threads;
}

function nesterOver(rows: Parameters<typeof fakeThreads>[0]) {
  const threads = fakeThreads(rows);
  const nester = createThreadNester(threads as unknown as Parameters<typeof createThreadNester>[0]);
  return { threads, nester };
}

const table = [
  { id: "root", projectId: "one", parentThreadId: null },
  { id: "child", projectId: "one", parentThreadId: "root" },
  { id: "grandchild", projectId: "one", parentThreadId: "child" },
  { id: "other", projectId: "one", parentThreadId: null },
  { id: "elsewhere", projectId: "two", parentThreadId: null },
];

describe("createThreadNester", () => {
  it("writes bb's parentThreadId for a valid nest and null for a lift", async () => {
    const { threads, nester } = nesterOver(table);
    assert.deepEqual(await nester.nest("other", "root"), { ok: true });
    assert.deepEqual(await nester.nest("grandchild", null), { ok: true });
    assert.deepEqual(threads.updates, [
      { threadId: "other", parentThreadId: "root" },
      { threadId: "grandchild", parentThreadId: null },
    ]);
  });

  it("refuses self, the current parent, a cycle, and a cross-project parent without writing", async () => {
    const { threads, nester } = nesterOver(table);
    assert.deepEqual(await nester.nest("root", "root"), { ok: false, reason: "self" });
    assert.deepEqual(await nester.nest("child", "root"), { ok: false, reason: "same-parent" });
    assert.deepEqual(await nester.nest("root", "grandchild"), { ok: false, reason: "cycle" });
    assert.deepEqual(await nester.nest("other", "elsewhere"), {
      ok: false,
      reason: "cross-project",
    });
    assert.deepEqual(await nester.nest("root", null), { ok: false, reason: "same-parent" });
    assert.deepEqual(threads.updates, []);
  });

  it("reports an unknown thread or a failed write", async () => {
    const { threads, nester } = nesterOver(table);
    assert.deepEqual(await nester.nest("missing", "root"), { ok: false, reason: "not-found" });
    assert.deepEqual(await nester.nest("other", "missing"), { ok: false, reason: "not-found" });
    threads.update = async () => {
      throw new Error("host offline");
    };
    assert.deepEqual(await nester.nest("other", "root"), { ok: false, reason: "update-failed" });
  });
});
