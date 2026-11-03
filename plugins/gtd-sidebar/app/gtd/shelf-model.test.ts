import { describe, expect, it } from "vitest";
import { buildInboxTree } from "../../lib/inbox-tree.ts";
import { makeSidebarThread, type SidebarThreadOverrides } from "../model/fixtures.ts";
import type { SidebarThread } from "../model/sidebar-thread.ts";
import {
  collapsedParents,
  isGroupFolded,
  isShelfFolded,
  toggleExpanded,
  withFold,
} from "./folds.ts";
import {
  buildShelfLayout,
  createArrivalComparator,
  pinnedFamilyIds,
  type ShelfLayoutInput,
} from "./shelf-model.ts";

function thread(id: string, overrides: SidebarThreadOverrides = {}): SidebarThread {
  return makeSidebarThread({
    id,
    projectId: "proj_a",
    createdAt: 1,
    updatedAt: 1,
    latestAttentionAt: 1,
    lastReadAt: 1,
    ...overrides,
  });
}

function layoutOf(threads: SidebarThread[], input: Partial<Omit<ShelfLayoutInput, "forest">> = {}) {
  return buildShelfLayout({
    forest: buildInboxTree(threads, () => "active"),
    mode: "project",
    projectOrder: ["proj_a", "proj_b"],
    personalProjectIds: new Set(["proj_personal"]),
    hostOrder: [],
    forceGroups: false,
    ...input,
  });
}

describe("pinnedFamilyIds", () => {
  it("takes each active pin with everything under it", () => {
    const threads = [
      thread("pin", { pinnedAt: 1 }),
      thread("child", { parentThreadId: "pin" }),
      thread("grandchild", { parentThreadId: "child" }),
      thread("loose"),
      thread("settled-pin", { pinnedAt: 1, archivedAt: 5 }),
    ];
    const ids = pinnedFamilyIds(threads, (item) => item.archivedAt === null);
    expect([...ids].sort()).toEqual(["child", "grandchild", "pin"]);
  });

  it("leaves an unpinned parent to its shelf when only a child is pinned", () => {
    const threads = [thread("parent"), thread("child", { parentThreadId: "parent", pinnedAt: 1 })];
    expect([...pinnedFamilyIds(threads, () => true)]).toEqual(["child"]);
  });
});

describe("buildShelfLayout", () => {
  it("keeps a family on its root's shelf, project, and machine", () => {
    const threads = [
      thread("root", { host: { id: "host_a", name: "Laptop" } }),
      thread("child", {
        parentThreadId: "root",
        projectId: "proj_b",
        host: { id: "host_b", name: "Server" },
      }),
      thread("other", { projectId: "proj_b" }),
    ];
    const byProject = layoutOf(threads);
    expect(byProject.grouped).toBe(true);
    expect(byProject.groupOf.get("child")).toBe("project:proj_a");
    expect(byProject.rootOf.get("child")).toBe("root");
    const byMachine = layoutOf(threads, { mode: "machine", hostOrder: ["host_b", "host_a"] });
    expect(byMachine.groupOf.get("child")).toBe("machine:host_a");
    expect(byMachine.shelves[0]?.groups.map((group) => group.key)).toEqual([
      "machine:host_a",
      "machine:no-machine",
    ]);
  });

  it("draws group headers only for a second group or an active machine filter", () => {
    const single = [thread("one"), thread("two")];
    expect(layoutOf(single).grouped).toBe(false);
    expect(layoutOf(single).shelves[0]?.groups).toEqual([]);
    expect(layoutOf(single, { forceGroups: true }).grouped).toBe(true);
    expect(
      layoutOf([thread("one"), thread("two", { projectId: "proj_b" })], { mode: "chronological" })
        .grouped,
    ).toBe(false);
  });

  it("orders groups by bb's project order with the personal project last", () => {
    const layout = layoutOf([
      thread("personal", { projectId: "proj_personal", updatedAt: 9 }),
      thread("b", { projectId: "proj_b" }),
      thread("unknown", { projectId: "proj_gone" }),
      thread("a"),
    ]);
    expect(layout.shelves[0]?.groups.map((group) => group.id)).toEqual([
      "proj_a",
      "proj_b",
      "proj_gone",
      "proj_personal",
    ]);
  });

  it("lists only shelves that hold a thread, in GTD's order", () => {
    const layout = buildShelfLayout({
      forest: buildInboxTree(
        [
          thread("settled", { archivedAt: 5 }),
          thread("busy", { indicator: "runtime" }),
          thread("quiet"),
          thread("parked"),
        ],
        (item) => (item.id === "parked" ? "snoozed" : "active"),
      ),
      mode: "project",
      projectOrder: ["proj_a"],
      personalProjectIds: new Set(),
      hostOrder: [],
      forceGroups: false,
    });
    expect(layout.shelves.map((view) => view.shelf)).toEqual([
      "nextAction",
      "waiting",
      "snoozed",
      "settled",
    ]);
    expect(layout.shelfOf.get("parked")).toBe("snoozed");
  });
});

describe("createArrivalComparator", () => {
  it("sorts roots by arrival, newest first, and children oldest first", () => {
    const threads = [
      thread("old", { latestAttentionAt: 1 }),
      thread("new", { latestAttentionAt: 9 }),
      thread("late-child", { parentThreadId: "new", createdAt: 5 }),
      thread("early-child", { parentThreadId: "new", createdAt: 2 }),
    ];
    const layout = layoutOf(threads);
    const byId = new Map(threads.map((item) => [item.id, item]));
    const sort = (ids: string[], descending = true) =>
      ids
        .map((id) => byId.get(id)!)
        .sort(createArrivalComparator(layout, descending))
        .map((item) => item.id);
    expect(sort(["old", "new"])).toEqual(["new", "old"]);
    expect(sort(["old", "new"], false)).toEqual(["old", "new"]);
    expect(sort(["late-child", "early-child"])).toEqual(["early-child", "late-child"]);
  });
});

describe("folds", () => {
  it("starts SlopCop, Snoozed, Settled, and Settled's groups folded", () => {
    expect(isShelfFolded({}, "nextAction")).toBe(false);
    expect(isShelfFolded({}, "snoozed")).toBe(true);
    expect(isShelfFolded({ snoozed: false }, "snoozed")).toBe(false);
    expect(isGroupFolded({}, "settled", "project:proj_a")).toBe(true);
    expect(isGroupFolded({}, "waiting", "project:proj_a")).toBe(false);
  });

  it("stores only overrides of the default", () => {
    const opened = withFold({}, "settled", false, true);
    expect(opened).toEqual({ settled: false });
    expect(withFold(opened, "settled", true, true)).toEqual({});
    const same = {};
    expect(withFold(same, "waiting", false, false)).toBe(same);
  });

  it("folds every family the user has not opened, and prunes gone ids", () => {
    const threads = [
      thread("root"),
      thread("child", { parentThreadId: "root" }),
      thread("other"),
      thread("other-child", { parentThreadId: "other" }),
    ];
    expect([...collapsedParents(threads, ["other"])]).toEqual(["root"]);
    expect(toggleExpanded(["gone", "other"], "root", new Set(["root", "other"]))).toEqual([
      "other",
      "root",
    ]);
    expect(toggleExpanded(["root"], "root", new Set(["root"]))).toEqual([]);
  });
});
