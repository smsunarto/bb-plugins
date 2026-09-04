// Single keys that act without a hint prompt. Each one either drives a
// pinned control straight away — the same control its hint label would pick
// after `f` — or steps the sidebar's thread list. All of them read only in
// idle mode, with no modifier held, outside an editable target, so typing in
// the composer never trips one.

import { RESERVED_CONTROLS } from "./hint-labels.ts";

export type DirectShortcut =
  | { readonly kind: "control"; readonly selector: string }
  | { readonly kind: "focus-composer" }
  | { readonly kind: "thread-step"; readonly step: -1 | 1 }
  | { readonly kind: "settle-thread" };

function pinnedControl(char: string): DirectShortcut {
  const control = RESERVED_CONTROLS.find((entry) => entry.char === char);
  if (control === undefined) throw new Error(`no reserved control pinned to ${char}`);
  return { kind: "control", selector: control.selector };
}

/**
 * The direct keys. The control keys reuse their hint-mode characters so one
 * mnemonic serves both paths. `[`, `]`, and `e` differ from their hint labels
 * on purpose: the hint keeps bb's back, forward, and Extensions controls,
 * while the direct key steps threads and settles the current one.
 */
export const DIRECT_SHORTCUTS: ReadonlyMap<string, DirectShortcut> = new Map([
  ["n", pinnedControl("n")],
  ["m", pinnedControl("m")],
  ["p", pinnedControl("p")],
  ["l", pinnedControl("l")],
  ["b", pinnedControl("b")],
  ["k", pinnedControl("k")],
  ["s", pinnedControl("s")],
  [",", pinnedControl(",")],
  ["i", { kind: "focus-composer" }],
  ["[", { kind: "thread-step", step: -1 }],
  ["]", { kind: "thread-step", step: 1 }],
  ["e", { kind: "settle-thread" }],
]);

/** The keydown facts the direct-shortcut decision reads. */
export interface DirectKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly editableTarget: boolean;
}

/** The shortcut a plain keydown maps to in idle mode, or null. */
export function directShortcutFor(key: DirectKey): DirectShortcut | null {
  if (key.ctrlKey || key.metaKey || key.altKey || key.shiftKey) return null;
  if (key.editableTarget) return null;
  return DIRECT_SHORTCUTS.get(key.key) ?? null;
}

const THREAD_PATH = /\/threads\/([^/?#]+)/;

/** The thread id a bb route shows, from `/threads/:id` or `/projects/:p/threads/:id`. */
export function threadIdFromPath(pathname: string): string | null {
  return THREAD_PATH.exec(pathname)?.[1] ?? null;
}

/**
 * The index to step to, matching bb's own previous/next thread commands: the
 * list wraps, and with no active thread `]` starts at the top and `[` at the
 * bottom. Null when there is nothing to step through.
 */
export function adjacentThreadIndex(
  ids: readonly string[],
  activeId: string | null,
  step: -1 | 1,
): number | null {
  if (ids.length === 0) return null;
  const active = activeId === null ? -1 : ids.indexOf(activeId);
  if (active === -1) return step === 1 ? 0 : ids.length - 1;
  return (active + step + ids.length) % ids.length;
}
