// Single keys that act without a hint prompt. Every one except scrolling is a
// bb command, listed in the palette and bound in Settings → Keyboard, and bb
// dispatches it. bb refuses a plugin default without Cmd, Ctrl, or Alt, so the
// single-key bindings live in the user's keyboard settings (README lists
// them). The scroll keys stay vimium's own, because bb drops repeated keydowns
// and a held `j` must keep scrolling. Both read only outside an editable
// target, so typing in the composer never trips one.

import { reservedControl, type ReservedControlId } from "./hint-labels.ts";

export type ScrollMotion = "down" | "up" | "bottom";

export type DirectShortcut =
  | { readonly kind: "hints" }
  | { readonly kind: "control"; readonly selector: string }
  | { readonly kind: "focus-composer" }
  | { readonly kind: "thread-search" }
  | { readonly kind: "thread-step"; readonly step: -1 | 1 }
  | { readonly kind: "settle-thread" }
  | { readonly kind: "undo-archive" }
  | { readonly kind: "cheatsheet" }
  | { readonly kind: "scroll"; readonly motion: ScrollMotion };

function pinnedControl(id: ReservedControlId): DirectShortcut {
  return { kind: "control", selector: reservedControl(id).selector };
}

export interface VimiumCommand {
  /** The bb command id, registered as `plugin:<plugin id>/<id>`. */
  readonly id: string;
  /** The palette row, Settings → Keyboard row, and cheatsheet row. */
  readonly title: string;
  readonly section: "Link hints" | "Navigation" | "Composer";
  readonly action: DirectShortcut;
}

/** The commands, in cheatsheet order. */
export const VIMIUM_COMMANDS: readonly VimiumCommand[] = [
  { id: "show-hints", title: "Show hints", section: "Link hints", action: { kind: "hints" } },
  {
    id: "new-thread",
    title: "New thread",
    section: "Navigation",
    action: pinnedControl("new-thread"),
  },
  { id: "home", title: "Home", section: "Navigation", action: pinnedControl("home") },
  {
    id: "search-threads",
    title: "Search threads",
    section: "Navigation",
    action: { kind: "thread-search" },
  },
  { id: "settings", title: "Settings", section: "Navigation", action: pinnedControl("settings") },
  {
    id: "next-thread",
    title: "Next thread",
    section: "Navigation",
    action: { kind: "thread-step", step: 1 },
  },
  {
    id: "previous-thread",
    title: "Previous thread",
    section: "Navigation",
    action: { kind: "thread-step", step: -1 },
  },
  {
    id: "settle-thread",
    title: "Settle the focused thread",
    section: "Navigation",
    action: { kind: "settle-thread" },
  },
  {
    id: "undo-archive",
    title: "Undo the latest archive",
    section: "Navigation",
    action: { kind: "undo-archive" },
  },
  {
    id: "cheatsheet",
    title: "Open the Vimium cheatsheet",
    section: "Navigation",
    action: { kind: "cheatsheet" },
  },
  {
    id: "focus-composer",
    title: "Focus the composer",
    section: "Composer",
    action: { kind: "focus-composer" },
  },
  {
    id: "model",
    title: "Open the model picker",
    section: "Composer",
    action: pinnedControl("model"),
  },
  {
    id: "project",
    title: "Open the project picker",
    section: "Composer",
    action: pinnedControl("project"),
  },
  {
    id: "machine",
    title: "Open the machine picker",
    section: "Composer",
    action: pinnedControl("machine"),
  },
  {
    id: "branch",
    title: "Open the branch picker",
    section: "Composer",
    action: pinnedControl("branch"),
  },
  {
    id: "permission-mode",
    title: "Open permission mode",
    section: "Composer",
    action: pinnedControl("permission"),
  },
];

/** The scroll keys vimium handles itself, since a held key must repeat. */
export const SCROLL_SHORTCUTS: ReadonlyMap<string, DirectShortcut> = new Map([
  ["j", { kind: "scroll", motion: "down" }],
  ["k", { kind: "scroll", motion: "up" }],
  ["J", { kind: "scroll", motion: "bottom" }],
]);

/** The keydown facts the scroll-key decision reads. */
export interface DirectKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly editableTarget: boolean;
}

/**
 * The scroll a plain keydown maps to in idle mode, or null. Shift is not a
 * gate: the exact-key lookup already leaves `K` unbound, and `J` needs it.
 */
export function directShortcutFor(key: DirectKey): DirectShortcut | null {
  if (key.ctrlKey || key.metaKey || key.altKey) return null;
  if (key.editableTarget) return null;
  return SCROLL_SHORTCUTS.get(key.key) ?? null;
}

/** The keydown facts that decide whether a bb command keypress is typing. */
export interface CommandKey {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly editableTarget: boolean;
}

/**
 * True when a keydown bb is about to dispatch as a vimium command belongs to
 * a text field instead. bb gives plugin commands no editable-focus guard, so
 * a bare `n` would otherwise open a new thread while typing. A chord the user
 * rebinds with Ctrl, Cmd, or Alt still runs from the composer.
 */
export function isTypingKey(key: CommandKey): boolean {
  return key.editableTarget && !key.ctrlKey && !key.metaKey && !key.altKey;
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
