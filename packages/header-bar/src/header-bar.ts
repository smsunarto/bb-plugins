/**
 * Shared client-side slot registry for a unified Vim-style thread statusbar.
 *
 * BB stacks separate `experimental_threadHeaderRow` registrations vertically,
 * which makes multiple plugins compete for the area under the thread header.
 * Instead, plugins publish compact, typed segments into fixed reserved slots
 * here while a single host renderer (`kitchen-sink`) draws one 32px statusbar
 * per thread pane.
 *
 * Each slot picks one winner by ascending `priority` (tie-broken by `owner`),
 * so higher-specificity context (e.g. Captain crew orientation) cleanly
 * supersedes generic lineage/subthread fallbacks without duplicate rows.
 */
import { useCallback, useId, useLayoutEffect, useSyncExternalStore } from "react";

export const HEADER_BAR_SLOTS = ["lineage", "task", "meta", "threads", "action"] as const;
export type HeaderBarSlot = (typeof HEADER_BAR_SLOTS)[number];

export const HEADER_BAR_LEFT_SLOTS = ["lineage", "task"] as const;
export const HEADER_BAR_RIGHT_SLOTS = ["meta", "threads", "action"] as const;

export type HeaderBarTone = "default" | "muted" | "accent" | "success" | "warning" | "destructive";

export type HeaderBarTaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";

export type HeaderBarTaskPriority = "urgent" | "high" | "medium" | "low";

export type HeaderBarGlyph =
  | { readonly kind: "icon"; readonly name: string; readonly tone?: HeaderBarTone }
  | { readonly kind: "image"; readonly src: string; readonly alt?: string }
  | { readonly kind: "dot"; readonly tone: HeaderBarTone; readonly pulse?: boolean }
  | { readonly kind: "task-status"; readonly status: HeaderBarTaskStatus }
  | { readonly kind: "task-priority"; readonly priority: HeaderBarTaskPriority };

export interface HeaderBarClickOptions {
  readonly split?: boolean;
}

export interface HeaderBarMenuItem {
  readonly id: string;
  readonly label: string;
  /** Optional monospace prefix (e.g. task key `BBP-42`). */
  readonly keyText?: string;
  /** Optional muted right-side detail (e.g. role or status). */
  readonly detail?: string;
  readonly glyph?: HeaderBarGlyph;
  readonly trailingGlyph?: HeaderBarGlyph;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (options?: HeaderBarClickOptions) => void;
}

export interface HeaderBarMenu {
  readonly triggerLabel: string;
  readonly ariaLabel: string;
  readonly title?: string;
  readonly glyph?: HeaderBarGlyph;
  readonly tone?: HeaderBarTone;
  readonly heading?: string;
  readonly items: readonly HeaderBarMenuItem[];
  readonly testId?: string;
}

export interface HeaderBarSegment {
  /** Plugin id owning this contribution (e.g. `"captain"`, `"scott-tasks"`, `"kitchen-sink"`). */
  readonly owner: string;
  /** Reserved slot in the statusbar. */
  readonly slot: HeaderBarSlot;
  /** Ascending precedence within `slot`; lower wins. */
  readonly priority: number;
  /** Optional leading directional/context icon (e.g. `"ArrowLeft"`, `"GitBranch"`). */
  readonly prefixIcon?: string;
  /** Optional leading glyph (icon, Captain PNG, status dot, task status/priority SVG). */
  readonly glyph?: HeaderBarGlyph;
  /** Optional monospace prefix before `label` (e.g. `"BBP-42"`). */
  readonly keyText?: string;
  /** Primary concise label (truncates when `shrink` is true). */
  readonly label?: string;
  /** Optional secondary tag beside `label` (e.g. role `"Implement"` or due date `"Dec 1"`). */
  readonly tag?: string;
  /** Optional glyph rendered directly before `tag`. */
  readonly tagGlyph?: HeaderBarGlyph;
  readonly tone?: HeaderBarTone;
  readonly tagTone?: HeaderBarTone;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly testId?: string;
  /** Primary click handler (renders the segment as an interactive button). */
  readonly onClick?: (options?: HeaderBarClickOptions) => void;
  /** Turns the segment into a compact dropdown menu trigger (e.g. `threads` slot). */
  readonly menu?: HeaderBarMenu;
  /** Optional compact secondary dropdown adjacent to the primary button (e.g. `+1` task switcher). */
  readonly secondaryMenu?: HeaderBarMenu;
  /** Allow the segment's label to shrink and truncate on narrow panes. */
  readonly shrink?: boolean;
}

export interface ResolvedHeaderBar {
  readonly threadId: string;
  readonly slots: Readonly<Partial<Record<HeaderBarSlot, HeaderBarSegment>>>;
  readonly left: readonly HeaderBarSegment[];
  readonly right: readonly HeaderBarSegment[];
  readonly isEmpty: boolean;
}

interface ContributionEntry {
  readonly owner: string;
  readonly segments: readonly HeaderBarSegment[];
}

interface HeaderBarRegistry {
  readonly byThread: Map<string, Map<string, ContributionEntry>>;
  readonly listenersByThread: Map<string, Set<() => void>>;
  readonly snapshotCache: Map<string, ResolvedHeaderBar>;
  readonly emptySnapshots: Map<string, ResolvedHeaderBar>;
}

const REGISTRY_SYMBOL = Symbol.for("bb-plugins.header-bar.registry.v1");

function getRegistry(): HeaderBarRegistry {
  const host = globalThis as Record<symbol, HeaderBarRegistry | undefined>;
  let registry = host[REGISTRY_SYMBOL];
  if (registry === undefined) {
    registry = {
      byThread: new Map(),
      listenersByThread: new Map(),
      snapshotCache: new Map(),
      emptySnapshots: new Map(),
    };
    host[REGISTRY_SYMBOL] = registry;
  }
  return registry;
}

function emptySnapshot(registry: HeaderBarRegistry, threadId: string): ResolvedHeaderBar {
  let snap = registry.emptySnapshots.get(threadId);
  if (snap === undefined) {
    snap = Object.freeze({
      threadId,
      slots: Object.freeze({}),
      left: Object.freeze([]),
      right: Object.freeze([]),
      isEmpty: true,
    });
    registry.emptySnapshots.set(threadId, snap);
  }
  return snap;
}

function notifyThread(registry: HeaderBarRegistry, threadId: string): void {
  registry.snapshotCache.delete(threadId);
  const listeners = registry.listenersByThread.get(threadId);
  if (listeners === undefined) return;
  for (const listener of listeners) {
    listener();
  }
}

function areGlyphsEqual(a: HeaderBarGlyph | undefined, b: HeaderBarGlyph | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "icon":
      return b.kind === "icon" && a.name === b.name && a.tone === b.tone;
    case "image":
      return b.kind === "image" && a.src === b.src && a.alt === b.alt;
    case "dot":
      return b.kind === "dot" && a.tone === b.tone && a.pulse === b.pulse;
    case "task-status":
      return b.kind === "task-status" && a.status === b.status;
    case "task-priority":
      return b.kind === "task-priority" && a.priority === b.priority;
  }
}

function areMenuItemsEqual(a: HeaderBarMenuItem, b: HeaderBarMenuItem): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.keyText === b.keyText &&
    a.detail === b.detail &&
    a.active === b.active &&
    a.disabled === b.disabled &&
    a.onSelect === b.onSelect &&
    areGlyphsEqual(a.glyph, b.glyph) &&
    areGlyphsEqual(a.trailingGlyph, b.trailingGlyph)
  );
}

function areMenusEqual(a: HeaderBarMenu | undefined, b: HeaderBarMenu | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (
    a.triggerLabel !== b.triggerLabel ||
    a.ariaLabel !== b.ariaLabel ||
    a.title !== b.title ||
    a.tone !== b.tone ||
    a.heading !== b.heading ||
    a.testId !== b.testId ||
    !areGlyphsEqual(a.glyph, b.glyph) ||
    a.items.length !== b.items.length
  ) {
    return false;
  }
  for (let i = 0; i < a.items.length; i++) {
    if (!areMenuItemsEqual(a.items[i]!, b.items[i]!)) return false;
  }
  return true;
}

function areSegmentsEqual(a: readonly HeaderBarSegment[], b: readonly HeaderBarSegment[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === right) continue;
    if (
      left.owner !== right.owner ||
      left.slot !== right.slot ||
      left.priority !== right.priority ||
      left.prefixIcon !== right.prefixIcon ||
      left.keyText !== right.keyText ||
      left.label !== right.label ||
      left.tag !== right.tag ||
      left.tone !== right.tone ||
      left.tagTone !== right.tagTone ||
      left.ariaLabel !== right.ariaLabel ||
      left.title !== right.title ||
      left.testId !== right.testId ||
      left.shrink !== right.shrink ||
      left.onClick !== right.onClick ||
      !areGlyphsEqual(left.glyph, right.glyph) ||
      !areGlyphsEqual(left.tagGlyph, right.tagGlyph) ||
      !areMenusEqual(left.menu, right.menu) ||
      !areMenusEqual(left.secondaryMenu, right.secondaryMenu)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Publish or update one mounted contributor's segments for `threadId`.
 * Passing an empty array clears this instance's segments for `threadId`.
 */
export function setHeaderBarSegments(
  threadId: string,
  instanceId: string,
  owner: string,
  segments: readonly HeaderBarSegment[],
): void {
  const registry = getRegistry();
  let entries = registry.byThread.get(threadId);
  if (segments.length === 0) {
    if (entries === undefined || !entries.has(instanceId)) return;
    entries.delete(instanceId);
    if (entries.size === 0) registry.byThread.delete(threadId);
    notifyThread(registry, threadId);
    return;
  }
  if (entries === undefined) {
    entries = new Map();
    registry.byThread.set(threadId, entries);
  } else {
    const existing = entries.get(instanceId);
    if (
      existing !== undefined &&
      existing.owner === owner &&
      areSegmentsEqual(existing.segments, segments)
    ) {
      return;
    }
  }
  entries.set(instanceId, { owner, segments });
  notifyThread(registry, threadId);
}

/** Remove all segments published by `instanceId` for `threadId`. */
export function clearHeaderBarSegments(threadId: string, instanceId: string): void {
  const registry = getRegistry();
  const entries = registry.byThread.get(threadId);
  if (entries === undefined || !entries.has(instanceId)) return;
  entries.delete(instanceId);
  if (entries.size === 0) registry.byThread.delete(threadId);
  notifyThread(registry, threadId);
}

/** Subscribe to statusbar changes for a specific `threadId`. */
export function subscribeHeaderBar(threadId: string, listener: () => void): () => void {
  const registry = getRegistry();
  let listeners = registry.listenersByThread.get(threadId);
  if (listeners === undefined) {
    listeners = new Set();
    registry.listenersByThread.set(threadId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = registry.listenersByThread.get(threadId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) {
      registry.listenersByThread.delete(threadId);
      registry.emptySnapshots.delete(threadId);
    }
  };
}

/** Resolve the winning segment per reserved slot for `threadId` (cached until mutated). */
export function getResolvedHeaderBar(threadId: string): ResolvedHeaderBar {
  const registry = getRegistry();
  const cached = registry.snapshotCache.get(threadId);
  if (cached !== undefined) return cached;

  const entries = registry.byThread.get(threadId);
  if (entries === undefined || entries.size === 0) {
    return emptySnapshot(registry, threadId);
  }

  const winners: Partial<Record<HeaderBarSlot, HeaderBarSegment>> = {};
  for (const entry of entries.values()) {
    for (const segment of entry.segments) {
      const existing = winners[segment.slot];
      if (
        existing === undefined ||
        segment.priority < existing.priority ||
        (segment.priority === existing.priority && segment.owner.localeCompare(existing.owner) < 0)
      ) {
        winners[segment.slot] = segment;
      }
    }
  }

  const left: HeaderBarSegment[] = [];
  for (const slot of HEADER_BAR_LEFT_SLOTS) {
    const winner = winners[slot];
    if (winner !== undefined) left.push(winner);
  }

  const right: HeaderBarSegment[] = [];
  for (const slot of HEADER_BAR_RIGHT_SLOTS) {
    const winner = winners[slot];
    if (winner !== undefined) right.push(winner);
  }

  const isEmpty = left.length === 0 && right.length === 0;
  if (isEmpty) {
    return emptySnapshot(registry, threadId);
  }

  const resolved: ResolvedHeaderBar = Object.freeze({
    threadId,
    slots: Object.freeze(winners),
    left: Object.freeze(left),
    right: Object.freeze(right),
    isEmpty: false,
  });
  registry.snapshotCache.set(threadId, resolved);
  return resolved;
}

/**
 * Publish a plugin's statusbar segments for `threadId` from inside a React component.
 * Automatically cleans up when the component unmounts, reloads, or switches threads.
 */
export function usePublishHeaderBarSegments(
  threadId: string,
  owner: string,
  segments: readonly HeaderBarSegment[],
): void {
  const reactId = useId();
  const instanceId = `${owner}:${reactId}`;

  useLayoutEffect(() => {
    setHeaderBarSegments(threadId, instanceId, owner, segments);
  }, [threadId, instanceId, owner, segments]);

  useLayoutEffect(
    () => () => {
      clearHeaderBarSegments(threadId, instanceId);
    },
    [threadId, instanceId],
  );
}

/** Subscribe to the resolved statusbar segments for `threadId`. */
export function useHeaderBarSnapshot(threadId: string): ResolvedHeaderBar {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeHeaderBar(threadId, onStoreChange),
    [threadId],
  );
  const getSnapshot = useCallback(() => getResolvedHeaderBar(threadId), [threadId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Clear all registry state. Intended for unit tests. */
export function resetHeaderBarRegistry(): void {
  const registry = getRegistry();
  const threadIds = [
    ...new Set([...registry.byThread.keys(), ...registry.listenersByThread.keys()]),
  ];
  registry.byThread.clear();
  registry.snapshotCache.clear();
  registry.emptySnapshots.clear();
  for (const threadId of threadIds) {
    const listeners = registry.listenersByThread.get(threadId);
    if (listeners === undefined) continue;
    for (const listener of listeners) listener();
  }
}
