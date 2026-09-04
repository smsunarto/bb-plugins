// Single keys that act without a hint prompt. Each one either drives a
// pinned control straight away — the same control its hint label would pick
// after `f` — steps the sidebar's thread list, or scrolls the conversation.
// All of them read only in idle mode, with no ctrl, meta, or alt held,
// outside an editable target, so typing in the composer never trips one.

import { RESERVED_CONTROLS } from "./hint-labels.ts";

export type ScrollMotion = "down" | "up" | "bottom";

export type DirectShortcut =
  | { readonly kind: "control"; readonly selector: string }
  | { readonly kind: "focus-composer" }
  | { readonly kind: "thread-step"; readonly step: -1 | 1 }
  | { readonly kind: "settle-thread" }
  | { readonly kind: "scroll"; readonly motion: ScrollMotion };

function pinnedControl(char: string): DirectShortcut {
  const control = RESERVED_CONTROLS.find((entry) => entry.char === char);
  if (control === undefined) throw new Error(`no reserved control pinned to ${char}`);
  return { kind: "control", selector: control.selector };
}

/**
 * The direct keys. The control keys reuse their hint-mode characters so one
 * mnemonic serves both paths. `[`, `]`, `e`, `j`, and `k` differ from their
 * hint labels on purpose: the hint keeps bb's back, forward, Extensions,
 * send, and permission-mode controls, while the direct key steps threads,
 * settles the current one, and scrolls the conversation.
 */
export const DIRECT_SHORTCUTS: ReadonlyMap<string, DirectShortcut> = new Map([
  ["n", pinnedControl("n")],
  ["m", pinnedControl("m")],
  ["p", pinnedControl("p")],
  ["l", pinnedControl("l")],
  ["b", pinnedControl("b")],
  ["s", pinnedControl("s")],
  [",", pinnedControl(",")],
  ["i", { kind: "focus-composer" }],
  ["[", { kind: "thread-step", step: -1 }],
  ["]", { kind: "thread-step", step: 1 }],
  ["e", { kind: "settle-thread" }],
  ["j", { kind: "scroll", motion: "down" }],
  ["k", { kind: "scroll", motion: "up" }],
  ["J", { kind: "scroll", motion: "bottom" }],
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

/**
 * The shortcut a plain keydown maps to in idle mode, or null. Shift is not a
 * gate: the exact-key lookup already leaves `M` and `{` unbound, and `J`
 * needs it.
 */
export function directShortcutFor(key: DirectKey): DirectShortcut | null {
  if (key.ctrlKey || key.metaKey || key.altKey) return null;
  if (key.editableTarget) return null;
  return DIRECT_SHORTCUTS.get(key.key) ?? null;
}

export const SCROLL_STEP_PX = 60;

/**
 * The relative distance a conversation scroll key asks for. A step needs no
 * clamp, because the scroller stops as soon as the area no longer moves.
 */
export function scrollAmountFor(
  motion: ScrollMotion,
  view: { scrollTop: number; scrollHeight: number; clientHeight: number },
): number {
  switch (motion) {
    case "down":
      return SCROLL_STEP_PX;
    case "up":
      return -SCROLL_STEP_PX;
    case "bottom":
      return Math.max(0, view.scrollHeight - view.clientHeight) - view.scrollTop;
  }
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
