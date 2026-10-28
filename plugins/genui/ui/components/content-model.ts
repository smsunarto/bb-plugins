// Pure readers behind the content renderers (content.tsx): they turn the
// loose shapes models write into the exact structures the components draw,
// and drop what they cannot read instead of throwing.
import type { Value } from "../../core/types";
import { isNode, isObject, optionalText, text, tone, type Tone } from "../values";

// ---------------------------------------------------------------------------
// KeyValue

export type KeyValuePair = readonly [label: string, value: Value];

/**
 * `{label: value}` or `[[label, value], …]` (also `{label|key, value}` rows).
 * Absent/null pairs are empty; any other shape is null (malformed).
 */
export function keyValuePairs(pairs: unknown): KeyValuePair[] | null {
  if (pairs === undefined || pairs === null) return [];
  if (Array.isArray(pairs)) {
    const result: KeyValuePair[] = [];
    for (const entry of pairs as readonly unknown[]) {
      if (Array.isArray(entry)) {
        // A streaming `[label]` shows its label before its value arrives.
        if (entry.length > 0) result.push([text(entry[0]), (entry[1] ?? null) as Value]);
      } else if (isObject(entry) && !isNode(entry) && ("label" in entry || "key" in entry)) {
        result.push([text(entry.label ?? entry.key), (entry.value ?? null) as Value]);
      }
    }
    return result.length > 0 || pairs.length === 0 ? result : null;
  }
  // Evaluated props are Values, so a plain object's fields are Values too.
  if (isObject(pairs) && !isNode(pairs)) return Object.entries(pairs) as KeyValuePair[];
  return null;
}

// ---------------------------------------------------------------------------
// Timeline

export interface TimelineEntry {
  readonly time: string | null;
  readonly title: string;
  readonly detail: string | null;
  readonly tone: Tone;
}

/** `{time, title, detail?, tone?}` items; a bare string or number is a title. */
export function timelineEntries(items: readonly unknown[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    if (typeof item === "string" || typeof item === "number") {
      const title = text(item);
      if (title !== "") entries.push({ time: null, title, detail: null, tone: "neutral" });
      continue;
    }
    if (!isObject(item) || isNode(item)) continue;
    const time = optionalText(item.time ?? item.date ?? null);
    const title = text(item.title ?? item.label ?? null);
    const detail = optionalText(item.detail ?? null);
    if (title === "" && !time && !detail) continue;
    entries.push({ time: time || null, title, detail: detail || null, tone: tone(item.tone as Value) });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tree

export interface TreeItem {
  /** Unique in its tree and stable while more items stream in. */
  readonly id: string;
  readonly label: string;
  /** The full path for items built from path strings; null for `{label}` items. */
  readonly path: string | null;
  /** A short status shown at the right: text or a node such as a Badge. */
  readonly note: Value | null;
  readonly folder: boolean;
  readonly children: readonly TreeItem[];
}

interface Draft {
  id: string;
  label: string;
  path: string | null;
  note: Value | null;
  folder: boolean;
  /** Built from a path string: merged by name, ordered folders first. */
  fromPath: boolean;
  children: Draft[];
  /** Path-built children by segment, for merging. */
  byName: Map<string, Draft>;
  /** `{label}` children per label, for unique ids. */
  labelCounts: Map<string, number>;
}

const ID_SEPARATOR = "\u001f";

function draft(id: string, label: string, path: string | null, fromPath: boolean): Draft {
  return {
    id,
    label,
    path,
    note: null,
    folder: false,
    fromPath,
    children: [],
    byName: new Map(),
    labelCounts: new Map(),
  };
}

/**
 * Adds `raw` under `parent`, creating or reusing one folder per segment.
 * Inside a `{label}` item the location is unknown, so the new items get no path.
 */
function addPath(parent: Draft, raw: string, withPaths: boolean): void {
  const trimmed = raw.trim();
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  const endsAsFolder = trimmed.endsWith("/");
  // An absolute path keeps its leading slash.
  const lead = trimmed.startsWith("/") ? "/" : "";
  let node = parent;
  segments.forEach((segment, index) => {
    let child = node.byName.get(segment);
    if (child === undefined) {
      const path = withPaths ? lead + segments.slice(0, index + 1).join("/") : null;
      child = draft(`${node.id}${ID_SEPARATOR}p${segment}`, segment, path, true);
      node.byName.set(segment, child);
      node.children.push(child);
    }
    // A segment with something below it is a folder, whatever came first.
    if (index < segments.length - 1 || endsAsFolder) child.folder = true;
    node = child;
  });
}

function addItems(parent: Draft, items: readonly unknown[], withPaths: boolean): void {
  for (const item of items) {
    if (typeof item === "string") {
      addPath(parent, item, withPaths);
      continue;
    }
    if (!isObject(item) || isNode(item)) continue;
    const label = text(item.label ?? item.name ?? null).trim();
    if (label === "") continue;
    const seen = parent.labelCounts.get(label) ?? 0;
    parent.labelCounts.set(label, seen + 1);
    const child = draft(`${parent.id}${ID_SEPARATOR}o${label}${seen === 0 ? "" : `#${seen}`}`, label, null, false);
    child.note = (item.note ?? null) as Value | null;
    if (Array.isArray(item.children)) {
      child.folder = true;
      addItems(child, item.children, false);
    }
    parent.children.push(child);
  }
}

/** Path-built siblings go folders first, each keeping first-seen order; `{label}` items keep their place. */
function finish(children: readonly Draft[]): TreeItem[] {
  const fromPaths = children.filter((child) => child.fromPath);
  const ordered = [...fromPaths.filter((child) => child.folder), ...fromPaths.filter((child) => !child.folder)];
  let next = 0;
  return children.map((child) => {
    const item = child.fromPath ? ordered[next++] : child;
    return {
      id: item.id,
      label: item.label,
      path: item.path,
      note: item.note,
      folder: item.folder,
      children: finish(item.children),
    };
  });
}

/**
 * Builds a tree from path strings ("src/core/a.ts") and `{label, children?,
 * note?}` items (children the same shape). Paths sharing folders merge,
 * duplicates collapse, and empty or unreadable entries are dropped.
 */
export function buildTree(items: readonly unknown[]): TreeItem[] {
  const root = draft("", "", null, false);
  addItems(root, items, true);
  return finish(root.children);
}

/**
 * Folders open by default, breadth first: each level opens while the
 * visible rows stay within `maxRows`, down to `maxDepth` levels of folders.
 */
export function defaultExpanded(roots: readonly TreeItem[], maxDepth = 3, maxRows = 50): Set<string> {
  const open = new Set<string>();
  let rows = roots.length;
  let level = roots;
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: TreeItem[] = [];
    for (const item of level) {
      if (!item.folder || item.children.length === 0 || rows + item.children.length > maxRows) continue;
      open.add(item.id);
      rows += item.children.length;
      next.push(...item.children);
    }
    level = next;
  }
  return open;
}

export interface TreeRow {
  readonly item: TreeItem;
  /** 0 for roots. */
  readonly depth: number;
  /** 1-based position among its siblings. */
  readonly position: number;
  readonly siblings: number;
  readonly parent: string | null;
}

/** The rows on screen, in order, given which folders are open. */
export function visibleRows(roots: readonly TreeItem[], isOpen: (id: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (items: readonly TreeItem[], depth: number, parent: string | null) => {
    items.forEach((item, index) => {
      rows.push({ item, depth, position: index + 1, siblings: items.length, parent });
      if (item.folder && isOpen(item.id)) walk(item.children, depth + 1, item.id);
    });
  };
  walk(roots, 0, null);
  return rows;
}
