// Sizes as Treemap shows them: path/size lists, nested trees, esbuild
// metafiles and `du` output read into one tree, and the squarified layout
// (Bruls, Huizing & van Wijk 2000) that turns a level of it into tiles.
// Pure; shared by the renderer and the markdown fallback.
import { objectFields, type Fields } from "./perf-units";
import type { Value } from "./types";

export interface TreeNode {
  readonly name: string;
  /** Names from the root down, joined with "/": a stable key. */
  readonly path: string;
  /** The node's size, its descendants' sum for a group. */
  readonly value: number;
  /** Largest first. */
  readonly children: readonly TreeNode[];
  /** A node_modules package (esbuild metafiles). */
  readonly package: boolean;
}

export interface Treemap {
  readonly source: "list" | "tree" | "esbuild" | "du";
  readonly root: TreeNode;
  /** "B" for metafiles and du, the given unit otherwise; null for plain numbers. */
  readonly unit: string | null;
  /** Items without a name or a positive size, left out. */
  readonly ignored: number;
}

export type TreemapRead = { readonly ok: true; readonly treemap: Treemap } | { readonly ok: false; readonly error: string };

const USAGE = "Treemap needs [{path, size}], [{name, children}], an esbuild metafile or du -k output";

/** A tree under construction: sizes of its own (a file, a du total) and children by name. */
interface Draft {
  name: string;
  own: number;
  /** A size the input gave for the whole node (du totals, nested `size`); its children's sum may fall short. */
  total: number | null;
  children: Map<string, Draft>;
  package: boolean;
}

function draft(name: string): Draft {
  return { name, own: 0, total: null, children: new Map(), package: false };
}

function child(parent: Draft, name: string): Draft {
  let found = parent.children.get(name);
  if (found === undefined) {
    found = draft(name);
    parent.children.set(name, found);
  }
  return found;
}

/** Path segments: `/` or `\` separated, without empty, `.` and leading `..` parts. */
export function pathSegments(path: string): string[] {
  const parts = path.split(/[/\\]+/).filter((part) => part !== "" && part !== ".");
  while (parts[0] === "..") parts.shift();
  return parts;
}

/** What the rest of a group holds beyond its listed children. */
const REST_NAME = "(rest)";

/** Freezes a draft: values summed bottom-up, a `total` beyond the children's sum kept as a "(rest)" child, children largest first. */
function freeze(node: Draft, path: string): TreeNode {
  const children = [...node.children.values()].map((kid) => freeze(kid, path === "" ? kid.name : `${path}/${kid.name}`));
  let sum = children.reduce((total, kid) => total + kid.value, 0);
  if (children.length > 0 && node.own > 0) {
    children.push({ name: REST_NAME, path: `${path}/${REST_NAME}`, value: node.own, children: [], package: false });
    sum += node.own;
  } else if (children.length === 0) {
    sum = node.own;
  }
  if (node.total !== null && node.total > sum) {
    if (children.length > 0) children.push({ name: REST_NAME, path: `${path}/${REST_NAME}`, value: node.total - sum, children: [], package: false });
    sum = node.total;
  }
  // Two "(rest)" children (own and total) merge into one.
  const merged: TreeNode[] = [];
  for (const kid of children) {
    const same = kid.name === REST_NAME ? merged.find((other) => other.name === REST_NAME) : undefined;
    if (same === undefined) merged.push(kid);
    else merged[merged.indexOf(same)] = { ...same, value: same.value + kid.value };
  }
  merged.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return { name: node.name, path, value: sum, children: merged, package: node.package };
}

/** The root, or the one group under it while it is the root's only child: "node_modules", not "(all) › node_modules". */
function trimRoot(root: TreeNode): TreeNode {
  let node = root;
  while (node.children.length === 1 && node.children[0].children.length > 0) node = node.children[0];
  return node;
}

function positive(value: Value | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function label(value: Value | undefined): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

// ---------------------------------------------------------------------------
// Inputs

function readList(items: readonly Value[]): { root: Draft; ignored: number; bytes: boolean; nested: boolean } {
  const root = draft("");
  let ignored = 0;
  let bytes = false;
  let nested = false;
  const addNested = (parent: Draft, fields: Fields): boolean => {
    const name = label(fields.name ?? fields.label ?? fields.path);
    const size = positive(fields.size ?? fields.value ?? fields.bytes);
    const kids = Array.isArray(fields.children) ? fields.children : null;
    if (name === "" || (size === null && (kids === null || kids.length === 0))) return false;
    const node = child(parent, name);
    if (kids !== null && kids.length > 0) {
      nested = true;
      if (size !== null) node.total = (node.total ?? 0) + size;
      for (const kid of kids) {
        const kidFields = objectFields(kid);
        if (kidFields === null || !addNested(node, kidFields)) ignored++;
      }
    } else if (size !== null) {
      node.own += size;
    }
    return true;
  };
  for (const item of items) {
    const fields = objectFields(item);
    if (fields === null) {
      ignored++;
      continue;
    }
    if (fields.bytes !== undefined) bytes = true;
    if (Array.isArray(fields.children)) {
      if (!addNested(root, fields)) ignored++;
      continue;
    }
    const path = label(fields.path ?? fields.name ?? fields.label);
    const size = positive(fields.size ?? fields.value ?? fields.bytes);
    const parts = pathSegments(path);
    if (parts.length === 0 || size === null) {
      ignored++;
      continue;
    }
    let node = root;
    for (const part of parts) node = child(node, part);
    node.own += size;
  }
  return { root, ignored, bytes, nested };
}

/** A node_modules path as [package, ...rest]: the last node_modules wins, scoped names keep their scope. */
export function packagePath(path: string): { package: string; rest: string[] } | null {
  const parts = pathSegments(path);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1 || at + 1 >= parts.length) return null;
  const scoped = parts[at + 1].startsWith("@") && at + 2 < parts.length;
  const name = scoped ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
  return { package: name, rest: parts.slice(at + (scoped ? 3 : 2)) };
}

/** esbuild --metafile: each output's `inputs[path].bytesInOutput`, packages grouped under node_modules. */
function readMetafile(outputs: Fields): { root: Draft; ignored: number } {
  const root = draft("");
  let ignored = 0;
  const files = Object.entries(outputs).flatMap(([name, output]) => {
    const inputs = name.endsWith(".map") ? null : objectFields(objectFields(output)?.inputs);
    return inputs === null ? [] : [{ name, inputs }];
  });
  for (const { name: outputName, inputs } of files) {
    // Several outputs (code splitting, css next to js): one group per output.
    const base = files.length > 1 ? child(root, pathSegments(outputName).pop() ?? outputName) : root;
    for (const [inputPath, input] of Object.entries(inputs)) {
      const bytes = objectFields(input)?.bytesInOutput;
      const size = positive(bytes);
      if (size === null) {
        // An input tree-shaken away (0 bytes) is a fact, not a problem.
        if (bytes !== 0) ignored++;
        continue;
      }
      const pkg = packagePath(inputPath);
      let node = base;
      if (pkg !== null) {
        node = child(child(node, "node_modules"), pkg.package);
        node.package = true;
        for (const part of pkg.rest) node = child(node, part);
      } else {
        const parts = pathSegments(inputPath);
        for (const part of parts.length === 0 ? [inputPath] : parts) node = child(node, part);
      }
      node.own += size;
    }
  }
  return { root, ignored };
}

const DU_SUFFIX: Record<string, number> = { "": 1024, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };

/** One `du` line: `size<TAB>path`; sizes in KB (`du -k`) or with a K/M/G suffix (`du -h`). */
function duLine(line: string): { bytes: number; path: string } | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*([bkmgtp])?i?b?\s+(.+?)\s*$/i.exec(line);
  if (match === null) return null;
  const amount = Number(match[1].replace(",", "."));
  const factor = DU_SUFFIX[(match[2] ?? "").toLowerCase()];
  return { bytes: amount * factor, path: match[3] };
}

/**
 * `du` output: every line a directory's (or with -a a file's) total, parents
 * after their children. A directory's own files are its total minus its
 * listed children: they show as "(rest)".
 */
function readDu(text: string): { root: Draft; ignored: number; lines: number } {
  const root = draft("");
  let ignored = 0;
  let lines = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const parsed = duLine(raw);
    const parts = parsed === null ? [] : pathSegments(parsed.path);
    if (parsed === null || parts.length === 0) {
      ignored++;
      continue;
    }
    lines++;
    let node = root;
    for (const part of parts) node = child(node, part);
    if (parsed.bytes > 0) node.total = Math.max(node.total ?? 0, parsed.bytes);
  }
  return { root, ignored, lines };
}

/** Reads any input Treemap takes; `unit` overrides the default ("B" for metafiles and du). */
export function readTreemap(value: Value | undefined, unit: string | null): TreemapRead {
  if (value === undefined || value === null) return { ok: false, error: USAGE };
  let result: { root: Draft; ignored: number } | null = null;
  let source: Treemap["source"] = "list";
  let defaultUnit: string | null = null;
  const fields = objectFields(value);
  const outputs = objectFields(fields?.outputs);
  if (typeof value === "string") {
    const du = readDu(value);
    if (du.lines === 0) return { ok: false, error: "No du lines (size<TAB>path) in this text" };
    result = du;
    source = "du";
    defaultUnit = "B";
  } else if (outputs !== null) {
    result = readMetafile(outputs);
    source = "esbuild";
    defaultUnit = "B";
  } else if (fields !== null && Array.isArray(fields.children)) {
    const list = readList([value]);
    result = list;
    source = "tree";
    if (list.bytes) defaultUnit = "B";
  } else if (Array.isArray(value)) {
    const list = readList(value);
    result = list;
    source = list.nested ? "tree" : "list";
    if (list.bytes) defaultUnit = "B";
  }
  if (result === null) return { ok: false, error: USAGE };
  const root = trimRoot(freeze(result.root, ""));
  return { ok: true, treemap: { source, root, unit: unit ?? defaultUnit, ignored: result.ignored } };
}

/** The node at `path` under `root` (a TreeNode path), or null. */
export function findNode(root: TreeNode, path: string): TreeNode | null {
  if (path === root.path) return root;
  for (const kid of root.children) {
    if (path === kid.path || path.startsWith(`${kid.path}/`)) return findNode(kid, path);
  }
  return null;
}

/** The nodes from `root` down to the one at `path`, both included; just [root] when it isn't there. */
export function trail(root: TreeNode, path: string): TreeNode[] {
  const chain: TreeNode[] = [root];
  for (let node = root; node.path !== path; ) {
    const next = node.children.find((kid) => path === kid.path || path.startsWith(`${kid.path}/`));
    if (next === undefined) return [root];
    chain.push(next);
    node = next;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Layout

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The worst aspect ratio of a row of `areas` laid along a side `side` long. */
function worst(areas: readonly number[], side: number): number {
  const sum = areas.reduce((total, area) => total + area, 0);
  if (sum === 0 || side === 0) return Number.POSITIVE_INFINITY;
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/**
 * Squarified treemap layout: rects for `values` (in their order) filling
 * `rect`, each with an area proportional to its value and as close to a
 * square as the greedy row-by-row method gets. Values are laid largest
 * first; zero and negative values get empty rects.
 */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const order = values
    .map((value, index) => ({ value: Number.isFinite(value) && value > 0 ? value : 0, index }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = order.reduce((sum, entry) => sum + entry.value, 0);
  if (total === 0 || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  let { x, y, w, h } = rect;
  let row: { area: number; index: number }[] = [];
  const place = () => {
    const sum = row.reduce((total, entry) => total + entry.area, 0);
    if (w >= h) {
      // A column along the left side.
      const width = h === 0 ? 0 : sum / h;
      let at = y;
      for (const entry of row) {
        const height = width === 0 ? 0 : entry.area / width;
        out[entry.index] = { x, y: at, w: width, h: height };
        at += height;
      }
      x += width;
      w = Math.max(0, w - width);
    } else {
      // A row along the top.
      const height = w === 0 ? 0 : sum / w;
      let at = x;
      for (const entry of row) {
        const width = height === 0 ? 0 : entry.area / height;
        out[entry.index] = { x: at, y, w: width, h: height };
        at += width;
      }
      y += height;
      h = Math.max(0, h - height);
    }
    row = [];
  };
  for (const entry of order) {
    const area = entry.value * scale;
    const side = Math.min(w, h);
    const areas = row.map((item) => item.area);
    if (row.length === 0 || worst([...areas, area], side) <= worst(areas, side)) {
      row.push({ area, index: entry.index });
    } else {
      place();
      row.push({ area, index: entry.index });
    }
  }
  if (row.length > 0) place();
  return out;
}

export interface Tile extends Rect {
  readonly node: TreeNode;
  /** 1 for the shown root's children, 2 for theirs. */
  readonly level: 1 | 2;
  /** The level-1 group this tile belongs to (its position among the root's children): its colour. */
  readonly group: number;
  /** Children folded into this one tile ("12 more"), when there were too many to draw. */
  readonly folded: number;
}

export interface TreemapLayout {
  readonly tiles: readonly Tile[];
}

/** Tiles per group before the rest fold into one "N more" tile. */
const MAX_CHILDREN = 24;
/** A child smaller than this share of its parent folds into "N more". */
const MIN_SHARE = 0.004;
/** The strip a level-1 group keeps for its name above its children. */
export const GROUP_HEADER = 18;
const GROUP_PADDING = 2;
/** The smallest level-1 group that shows its children inside. */
const NEST_MIN_WIDTH = 64;
const NEST_MIN_HEIGHT = 48;

/** A node's children as drawn: the largest up to MAX_CHILDREN, the rest folded into one node. */
export function visibleChildren(node: TreeNode, limit = MAX_CHILDREN): { nodes: TreeNode[]; folded: number[] } {
  const kept: TreeNode[] = [];
  const rest: TreeNode[] = [];
  for (const kid of node.children) {
    if (kept.length < limit && kid.value >= node.value * MIN_SHARE) kept.push(kid);
    else rest.push(kid);
  }
  // Folding one child gains nothing: show it.
  if (rest.length === 1) {
    kept.push(rest[0]);
    rest.length = 0;
  }
  if (rest.length === 0) return { nodes: kept, folded: kept.map(() => 0) };
  const value = rest.reduce((sum, kid) => sum + kid.value, 0);
  const more: TreeNode = { name: `${rest.length} more`, path: `${node.path}/…more`, value, children: [], package: false };
  return { nodes: [...kept, more], folded: [...kept.map(() => 0), rest.length] };
}

/**
 * Two levels of tiles for `root` in a `width` × `height` box: its children,
 * and inside each child big enough, a name strip and its own children.
 */
export function layoutTreemap(root: TreeNode, width: number, height: number): TreemapLayout {
  const tiles: Tile[] = [];
  const top = visibleChildren(root);
  const rects = squarify(
    top.nodes.map((node) => node.value),
    { x: 0, y: 0, w: width, h: height },
  );
  top.nodes.forEach((node, group) => {
    const rect = rects[group];
    if (rect.w <= 0 || rect.h <= 0) return;
    tiles.push({ ...rect, node, level: 1, group, folded: top.folded[group] });
    if (node.children.length === 0 || top.folded[group] > 0 || rect.w < NEST_MIN_WIDTH || rect.h < NEST_MIN_HEIGHT) return;
    const inner = {
      x: rect.x + GROUP_PADDING,
      y: rect.y + GROUP_HEADER,
      w: rect.w - GROUP_PADDING * 2,
      h: rect.h - GROUP_HEADER - GROUP_PADDING,
    };
    const kids = visibleChildren(node, 16);
    squarify(
      kids.nodes.map((kid) => kid.value),
      inner,
    ).forEach((kidRect, index) => {
      if (kidRect.w > 0 && kidRect.h > 0) tiles.push({ ...kidRect, node: kids.nodes[index], level: 2, group, folded: kids.folded[index] });
    });
  });
  return { tiles };
}
