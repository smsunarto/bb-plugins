// The rows `Json` shows: only open containers contribute children, and a
// container shows its first `shown` children followed by a "N more" row, so a
// thousand-item array costs a hundred rows until the user asks for more.
// Each row's id is its JSONPath (`$.items[3].name`), which is also what
// "copy path" copies. Pure: no React, no DOM.
import type { Value } from "../../core/types";

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

/** Children a container shows before its "N more" row, and how many each click adds. */
export const CHILD_PAGE = 100;
/** Characters of a string shown before it is cut with an expand control. */
export const STRING_PREVIEW = 160;

export function jsonKind(value: Value): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The JSONPath of `key` under `parent`: `$.name`, `$[3]`, `$["two words"]`. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** A container's entries in order: indexes for arrays, own keys for objects; none for scalars. */
export function entries(value: Value): readonly (readonly [string | number, Value])[] {
  if (Array.isArray(value)) return value.map((item: Value, index) => [index, item] as const);
  if (typeof value === "object" && value !== null) return Object.entries(value as Record<string, Value>);
  return [];
}

/** `3 keys`, `1 item`, `0 items`; empty for scalars. */
export function sizeText(value: Value): string {
  if (typeof value !== "object" || value === null) return "";
  const array = Array.isArray(value);
  const count = array ? value.length : Object.keys(value).length;
  return `${count} ${array ? "item" : "key"}${count === 1 ? "" : "s"}`;
}

/** What copying a value puts on the clipboard: strings bare, other scalars as written, containers as indented JSON. */
export function copyText(value: Value): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value, null, 2);
}

export interface ValueRow {
  readonly type: "value";
  /** The JSONPath. */
  readonly id: string;
  readonly depth: number;
  /** Null for the root of a scalar. */
  readonly key: string | number | null;
  readonly value: Value;
  readonly kind: JsonKind;
  readonly parent: string | null;
  readonly position: number;
  readonly siblings: number;
  /** Entries of an object or array; 0 for scalars and empty containers, which do not expand. */
  readonly children: number;
}

export interface MoreRow {
  readonly type: "more";
  readonly id: string;
  readonly depth: number;
  /** The container this row pages. */
  readonly parent: string;
  /** The children of `parent` already shown, which is where the next page starts. */
  readonly shown: number;
  readonly remaining: number;
}

export type JsonRow = ValueRow | MoreRow;

/**
 * The rows on screen. A container root is not a row of its own (its size is
 * the caption): its entries are the top level. `isOpen(id)` says whether a
 * container is expanded; `shown(id)` how many of its children are on screen.
 */
export function visibleRows(root: Value, isOpen: (id: string) => boolean, shown: (id: string) => number): JsonRow[] {
  const rows: JsonRow[] = [];
  const rootKind = jsonKind(root);
  if (rootKind !== "array" && rootKind !== "object") {
    rows.push({ type: "value", id: "$", depth: 0, key: null, value: root, kind: rootKind, parent: null, position: 1, siblings: 1, children: 0 });
    return rows;
  }
  // Depth-first with an explicit stack of open containers: deep values never recurse.
  interface Open {
    readonly id: string;
    readonly all: readonly (readonly [string | number, Value])[];
    readonly limit: number;
    readonly depth: number;
    next: number;
  }
  const open = (id: string, value: Value, depth: number): Open => {
    const all = entries(value);
    return { id, all, limit: Math.min(all.length, Math.max(0, shown(id))), depth, next: 0 };
  };
  const stack: Open[] = [open("$", root, 0)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.next >= frame.limit) {
      stack.pop();
      if (frame.limit < frame.all.length) {
        rows.push({ type: "more", id: `${frame.id}…`, depth: frame.depth, parent: frame.id, shown: frame.limit, remaining: frame.all.length - frame.limit });
      }
      continue;
    }
    const index = frame.next++;
    const [key, child] = frame.all[index];
    const id = childPath(frame.id, key);
    const kind = jsonKind(child);
    const parent = frame.depth === 0 ? null : frame.id;
    const children = Array.isArray(child) ? child.length : typeof child === "object" && child !== null ? Object.keys(child).length : 0;
    rows.push({ type: "value", id, depth: frame.depth, key, value: child, kind, parent, position: index + 1, siblings: frame.all.length, children });
    if (children > 0 && isOpen(id)) stack.push(open(id, child, frame.depth + 1));
  }
  return rows;
}

/**
 * Containers open before the user touches anything. The top level always
 * shows; below it a lone container entry opens, and so on down, so an
 * envelope like `{data: {...}}` shows its content instead of one closed row.
 */
export function defaultOpen(root: Value): ReadonlySet<string> {
  const ids = new Set<string>();
  let id = "$";
  let current = entries(root);
  while (current.length === 1) {
    const [key, child] = current[0];
    const kind = jsonKind(child);
    if (kind !== "array" && kind !== "object") break;
    id = childPath(id, key);
    ids.add(id);
    current = entries(child);
  }
  return ids;
}
