import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataFile } from "./data";
import { findNode, layoutTreemap, packagePath, readTreemap, squarify, trail, visibleChildren, type Rect, type Treemap } from "./treemap";
import type { Value } from "./types";

function fixture(name: string): Value {
  const loaded = parseDataFile(name, readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8"));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

function read(value: Value, unit: string | null = null): Treemap {
  const result = readTreemap(value, unit);
  if (!result.ok) throw new Error(result.error);
  return result.treemap;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

describe("squarify", () => {
  const box = { x: 0, y: 0, w: 600, h: 400 };

  it("gives each value an area in proportion, inside the box, without overlaps", () => {
    const values = [500, 300, 120, 60, 10, 6, 4];
    const rects = squarify(values, box);
    const total = values.reduce((sum, n) => sum + n, 0);
    rects.forEach((rect, index) => {
      expect(rect.w * rect.h).toBeCloseTo((values[index] / total) * box.w * box.h, 6);
      expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.x + rect.w).toBeLessThanOrEqual(box.w + 1e-9);
      expect(rect.y + rect.h).toBeLessThanOrEqual(box.h + 1e-9);
    });
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) expect(overlap(rects[a], rects[b])).toBeLessThan(1e-6);
  });

  it("keeps tiles near square", () => {
    const rects = squarify(Array.from({ length: 16 }, () => 1), { x: 0, y: 0, w: 400, h: 400 });
    for (const rect of rects) expect(Math.max(rect.w / rect.h, rect.h / rect.w)).toBeLessThan(2.01);
  });

  it("returns rects in input order even when unsorted", () => {
    const rects = squarify([1, 3], { x: 0, y: 0, w: 40, h: 10 });
    expect(rects[1].w * rects[1].h).toBeCloseTo(300);
    expect(rects[0].w * rects[0].h).toBeCloseTo(100);
  });

  it("gives empty rects to zero, negative and NaN values and an empty box", () => {
    const rects = squarify([0, -5, Number.NaN, 10], box);
    expect(rects.slice(0, 3).every((rect) => rect.w === 0 && rect.h === 0)).toBe(true);
    expect(rects[3]).toEqual(box);
    expect(squarify([1, 2], { x: 0, y: 0, w: 0, h: 10 }).every((rect) => rect.w === 0)).toBe(true);
    expect(squarify([], box)).toEqual([]);
  });
});

describe("path/size lists", () => {
  it("splits paths into groups and sums them", () => {
    const treemap = read([
      { path: "src/app.ts", size: 40 },
      { path: "src/lib/a.ts", size: 25 },
      { path: "src\\lib\\b.ts", size: 15 },
      { path: "./README.md", size: 20 },
    ]);
    expect(treemap.source).toBe("list");
    expect(treemap.root.value).toBe(100);
    expect(treemap.root.children.map((node) => [node.name, node.value])).toEqual([
      ["src", 80],
      ["README.md", 20],
    ]);
    expect(findNode(treemap.root, "src/lib")?.value).toBe(40);
    expect(trail(treemap.root, "src/lib/a.ts").map((node) => node.name)).toEqual(["", "src", "lib", "a.ts"]);
    expect(treemap.unit).toBeNull();
  });

  it("uses bytes as B and keeps a group's own size as (rest)", () => {
    const treemap = read([
      { name: "docs", bytes: 10 },
      { name: "docs/a.md", bytes: 5 },
      { name: "unicode/日本.txt", bytes: 3 },
      { name: "zero", bytes: 0 },
      "junk",
    ]);
    expect(treemap.unit).toBe("B");
    expect(findNode(treemap.root, "docs")?.children.map((node) => node.name)).toEqual(["(rest)", "a.md"]);
    expect(findNode(treemap.root, "unicode/日本.txt")?.value).toBe(3);
    expect(treemap.ignored).toBe(2);
  });

  it("reads nested trees, a parent's size beyond its children kept as (rest)", () => {
    const treemap = read(
      [
        { name: "compute", size: 1200, children: [{ name: "ec2", size: 900 }, { name: "lambda", size: 100 }] },
        { name: "storage", children: [{ name: "s3", size: 300 }] },
      ],
      "$",
    );
    expect(treemap.source).toBe("tree");
    expect(treemap.unit).toBe("$");
    expect(treemap.root.value).toBe(1500);
    expect(findNode(treemap.root, "compute")?.children.map((node) => [node.name, node.value])).toEqual([
      ["ec2", 900],
      ["(rest)", 200],
      ["lambda", 100],
    ]);
  });
});

describe("esbuild metafile", () => {
  it("groups node_modules by package and sums bytesInOutput", () => {
    const treemap = read(fixture("esbuild-meta.json"));
    expect(treemap.source).toBe("esbuild");
    expect(treemap.unit).toBe("B");
    // The metafile as esbuild documents it, read straight from the file for the expected sum.
    const metafile: { outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> } = JSON.parse(
      readFileSync(new URL("../gallery/data/esbuild-meta.json", import.meta.url), "utf8"),
    );
    const total = Object.values(metafile.outputs)
      .flatMap((output) => Object.values(output.inputs))
      .reduce((sum, input) => sum + input.bytesInOutput, 0);
    expect(treemap.root.value).toBe(total);
    const modules = findNode(treemap.root, "node_modules")!;
    expect(modules.children.every((node) => node.package)).toBe(true);
    expect(modules.children.map((node) => node.name)).toContain("@radix-ui/react-dialog");
    expect(treemap.root.children[0].name).toBe("ui");
  });

  it("finds the package of nested and scoped node_modules paths", () => {
    expect(packagePath("node_modules/react-dom/cjs/react-dom.js")).toEqual({ package: "react-dom", rest: ["cjs", "react-dom.js"] });
    expect(packagePath("../node_modules/a/node_modules/@scope/b/index.js")).toEqual({ package: "@scope/b", rest: ["index.js"] });
    expect(packagePath("src/index.ts")).toBeNull();
  });

  it("puts each output in its own group when there are several", () => {
    const treemap = read({
      outputs: {
        "dist/a.js": { bytes: 30, inputs: { "src/a.ts": { bytesInOutput: 30 } } },
        "dist/a.js.map": { bytes: 99, inputs: {} },
        "dist/b.css": { bytes: 10, inputs: { "src/b.css": { bytesInOutput: 10 } } },
      },
    });
    expect(treemap.root.children.map((node) => node.name)).toEqual(["a.js", "b.css"]);
  });
});

describe("du", () => {
  it("reads du -k totals, the directory's own files as (rest)", () => {
    const treemap = read(fixture("du-node-modules.txt"));
    expect(treemap.source).toBe("du");
    // The single top-level directory becomes the root.
    expect(treemap.root.name).toBe("node_modules");
    const text = readFileSync(new URL("../gallery/data/du-node-modules.txt", import.meta.url), "utf8");
    const rootLine = text.split("\n").find((line) => /\tnode_modules$/.test(line))!;
    expect(treemap.root.value).toBe(Number(rootLine.split("\t")[0]) * 1024);
    const typescript = findNode(treemap.root, "node_modules/typescript")!;
    expect(typescript.value).toBe(23388 * 1024);
    expect(typescript.children[0].name).toBe("lib");
  });

  it("takes du -h suffixes, Windows paths and spaces", () => {
    const treemap = read("1.5M\tproj\\assets\n512K\tproj\\my docs\n3M\tproj\n");
    expect(treemap.root.name).toBe("proj");
    expect(treemap.root.value).toBe(3 * 1024 ** 2);
    expect(treemap.root.children.map((node) => node.name)).toEqual(["assets", "(rest)", "my docs"]);
  });

  it("says when text has no du lines", () => {
    expect(readTreemap("hello world", null)).toEqual({ ok: false, error: "No du lines (size<TAB>path) in this text" });
  });
});

describe("layout", () => {
  it("folds the long tail into one tile", () => {
    const treemap = read(Array.from({ length: 60 }, (_, index) => ({ path: `f${index}`, size: 60 - index })));
    const { nodes, folded } = visibleChildren(treemap.root);
    expect(nodes).toHaveLength(25);
    expect(nodes[24].name).toBe("36 more");
    expect(folded[24]).toBe(36);
    expect(nodes.reduce((sum, node) => sum + node.value, 0)).toBe(treemap.root.value);
  });

  it("lays two levels, children inside their group below its name strip", () => {
    const treemap = read([
      { path: "a/x", size: 50 },
      { path: "a/y", size: 30 },
      { path: "b", size: 20 },
    ]);
    const { tiles } = layoutTreemap(treemap.root, 400, 300);
    const groupA = tiles.find((tile) => tile.node.name === "a" && tile.level === 1)!;
    const inner = tiles.filter((tile) => tile.level === 2);
    expect(inner.map((tile) => tile.node.name)).toEqual(["x", "y"]);
    for (const tile of inner) {
      expect(tile.group).toBe(groupA.group);
      expect(tile.y).toBeGreaterThanOrEqual(groupA.y + 18 - 1e-9);
      expect(tile.x + tile.w).toBeLessThanOrEqual(groupA.x + groupA.w + 1e-9);
    }
  });
});
