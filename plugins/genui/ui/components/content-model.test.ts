import { describe, expect, it } from "vitest";
import type { UiNode } from "../../core/types";
import { buildTree, defaultExpanded, keyValuePairs, timelineEntries, visibleRows, type TreeItem } from "./content-model";

/** label (folder marker) → children, for readable assertions. */
function shape(items: readonly TreeItem[]): unknown[] {
  return items.map((item) =>
    item.folder ? { [`${item.label}/`]: shape(item.children) } : item.label,
  );
}

function flatten(items: readonly TreeItem[]): TreeItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children)]);
}

function find(items: readonly TreeItem[], label: string): TreeItem {
  const item = flatten(items).find((candidate) => candidate.label === label);
  if (item === undefined) throw new Error(`no ${label}`);
  return item;
}

const BADGE: UiNode = { kind: "node", type: "Badge", key: "b", props: { text: "new" } };

describe("buildTree", () => {
  it("merges shared folders and puts folders before files in first-seen order", () => {
    const tree = buildTree(["README.md", "src/ui/b.tsx", "src/a.ts", "src/core/x.ts", "docs/", "src/ui/a.tsx", "package.json"]);
    expect(shape(tree)).toEqual([
      { "src/": [{ "ui/": ["b.tsx", "a.tsx"] }, { "core/": ["x.ts"] }, "a.ts"] },
      { "docs/": [] },
      "README.md",
      "package.json",
    ]);
  });

  it("keeps full paths for path items, including absolute ones", () => {
    const tree = buildTree(["src/core/a.ts", "/tmp/out.log"]);
    expect(find(tree, "a.ts").path).toBe("src/core/a.ts");
    expect(find(tree, "core").path).toBe("src/core");
    expect(find(tree, "out.log").path).toBe("/tmp/out.log");
  });

  it("collapses duplicates and turns a file into a folder once something is below it", () => {
    const tree = buildTree(["src", "src/a.ts", "src/a.ts", "./src//b.ts"]);
    expect(shape(tree)).toEqual([{ "src/": ["a.ts", "b.ts"] }]);
  });

  it("drops empty and unreadable entries", () => {
    expect(buildTree(["", "/", " ./ ", 42, null, true, [], BADGE, { children: ["x"] }, { label: "  " }])).toEqual([]);
  });

  it("builds nested label items in their given order, with notes and string leaves", () => {
    const tree = buildTree([
      { label: "Launch", note: "done" },
      { label: "Backend", note: BADGE, children: ["api/routes.ts", { label: "Database" }, "api/db.ts"] },
    ]);
    expect(shape(tree)).toEqual([
      "Launch",
      { "Backend/": [{ "api/": ["routes.ts", "db.ts"] }, "Database"] },
    ]);
    expect(find(tree, "Launch").note).toBe("done");
    expect(find(tree, "Backend").note).toEqual(BADGE);
    // Inside a label item the location is unknown: no path to open.
    expect(find(tree, "routes.ts").path).toBeNull();
    expect(find(tree, "Launch").path).toBeNull();
  });

  it("reorders path items around label items without moving the label items", () => {
    const tree = buildTree(["a.ts", { label: "Notes" }, "lib/b.ts"]);
    expect(shape(tree)).toEqual([{ "lib/": ["b.ts"] }, "Notes", "a.ts"]);
  });

  it("gives every item a unique id that survives more items arriving", () => {
    const first = buildTree(["src/a.ts", { label: "x" }, { label: "x" }]);
    const ids = flatten(first).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const later = buildTree(["src/a.ts", { label: "x" }, { label: "x" }, "src/b.ts", "lib/c.ts"]);
    expect(find(later, "src").id).toBe(find(first, "src").id);
    expect(find(later, "a.ts").id).toBe(find(first, "a.ts").id);
  });
});

describe("defaultExpanded", () => {
  it("opens folders down to three levels", () => {
    const tree = buildTree(["a/b/c/d/e.ts"]);
    const open = defaultExpanded(tree);
    expect(open.has(find(tree, "a").id)).toBe(true);
    expect(open.has(find(tree, "c").id)).toBe(true);
    expect(open.has(find(tree, "d").id)).toBe(false);
  });

  it("leaves a folder closed when opening it would pass the row budget", () => {
    const many = Array.from({ length: 60 }, (_, index) => `big/f${index}.ts`);
    const tree = buildTree(["small/a.ts", ...many]);
    const open = defaultExpanded(tree);
    expect(open.has(find(tree, "small").id)).toBe(true);
    expect(open.has(find(tree, "big").id)).toBe(false);
  });
});

describe("visibleRows", () => {
  it("lists open folders' children with depth and sibling positions", () => {
    const tree = buildTree(["src/a.ts", "src/b.ts", "README.md"]);
    const src = find(tree, "src").id;
    const rows = visibleRows(tree, (id) => id === src);
    expect(rows.map((row) => [row.item.label, row.depth, row.position, row.siblings])).toEqual([
      ["src", 0, 1, 2],
      ["a.ts", 1, 1, 2],
      ["b.ts", 1, 2, 2],
      ["README.md", 0, 2, 2],
    ]);
    expect(rows[1].parent).toBe(src);
    expect(visibleRows(tree, () => false)).toHaveLength(2);
  });
});

describe("keyValuePairs", () => {
  it("reads objects, [label, value] lists and {label, value} rows", () => {
    expect(keyValuePairs({ Owner: "Ana", Seats: 3 })).toEqual([["Owner", "Ana"], ["Seats", 3]]);
    expect(keyValuePairs([["Status", BADGE], ["Region"], { key: "Plan", value: "Pro" }])).toEqual([
      ["Status", BADGE],
      ["Region", null],
      ["Plan", "Pro"],
    ]);
  });

  it("is empty for nothing and null for shapes it cannot read", () => {
    expect(keyValuePairs(null)).toEqual([]);
    expect(keyValuePairs([])).toEqual([]);
    expect(keyValuePairs("Owner: Ana")).toBeNull();
    expect(keyValuePairs(BADGE)).toBeNull();
    expect(keyValuePairs([1, 2])).toBeNull();
  });
});

describe("timelineEntries", () => {
  it("reads items and bare titles, defaulting the tone and skipping blanks", () => {
    expect(
      timelineEntries([
        { time: "09:00", title: "Deploy", detail: "v2.1", tone: "good" },
        "Retro",
        { time: 2024, title: "Founded", tone: "loud" },
        { title: "" },
        null,
        BADGE,
      ]),
    ).toEqual([
      { time: "09:00", title: "Deploy", detail: "v2.1", tone: "good" },
      { time: null, title: "Retro", detail: null, tone: "neutral" },
      { time: "2024", title: "Founded", detail: null, tone: "neutral" },
    ]);
  });
});
