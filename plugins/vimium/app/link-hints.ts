// @smsunarto/bb-plugin-vimium — Vimium-style `f` link hints over the bb app shell.
//
// One content script, one capture-phase keydown listener, one state machine:
// idle until a plain `f` lands outside an editable target — or `Cmd+Shift+F`
// lands anywhere — then a marker per
// visible clickable element until the typed characters pick one — or Escape,
// Backspace past the start, a non-hint key, a scroll, a resize, or a blur
// exits. Built-in composer controls keep pinned single-character labels and
// sidebar thread rows count 1-9; everything else gets two-character labels.
// The conversation timeline is a quiet zone: it rerenders and auto-scrolls
// itself while an agent streams, so nothing inside it gets a hint and its own
// scrolling never dismisses one — only a scroll that moves a hinted target
// does. A hint that lands on a dropdown trigger re-prompts once the popup
// appears, with hints scoped to its options and labels ordered for the home
// row; the scoped prompt follows the popup — exiting when it is dismissed,
// re-prompting when a pick leaves it open (the model dialog and its tabs),
// and handing focus back to the composer when a pick from one of the
// composer's own dropdowns closes it. On fine-pointer devices, passive
// composer focus is released so normal mode survives navigation; `i`, a
// direct pointer press, and Tab focus enter the composer intentionally.
// Coarse-pointer devices retain native composer focus. `Cmd+Shift+F` always
// means the whole screen: it replaces a scoped prompt, and first closes any
// open popup layer,
// which would otherwise aria-hide the rest of the page. In idle mode a few
// plain keys skip the prompt: the pinned control keys (`n`, `m`, `p`, `l`,
// `b`, `s`, `,`) drive their control directly, `[` and `]` step the
// sidebar's thread list, `e` settles the current thread, and `j`, `k`, and
// `J` scroll the conversation a step down, a step up, and to the bottom. The
// transitions and predicates are pure functions so they test without a DOM;
// only mounting, marker drawing, and activation touch one.

import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import {
  SCROLL_STEP_PX,
  adjacentThreadIndex,
  directShortcutFor,
  scrollAmountFor,
  threadIdFromPath,
  type DirectShortcut,
} from "./direct-shortcuts.ts";
import { createScroller } from "./scroller.ts";
import {
  RESERVED_CONTROLS,
  TEXT_CONTROLS,
  assignScopedLabels,
  assignTopLevelLabels,
  type ScopedFact,
  type ScopedKind,
  type TopLevelFact,
} from "./hint-labels.ts";

type HintMode =
  | { kind: "idle" }
  | {
      kind: "active";
      hints: readonly Hint[];
      typed: string;
      /** The popup a scoped reprompt is pinned to; null for a whole-screen prompt. */
      scopeRoot: HTMLElement | null;
      /** True when picking from this scope should hand focus back to the composer. */
      refocusComposer: boolean;
      /** The label policy retained while a popup changes its contents. */
      scopeKind: ScopedKind;
    };

interface Hint {
  readonly label: string;
  readonly target: HTMLElement;
  readonly marker: HTMLElement;
}

const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

export type ActiveTransition =
  | { kind: "ignore" }
  | { kind: "exit" }
  | { kind: "retype"; typed: string }
  | { kind: "activate"; label: string };

/**
 * What one keydown does to active hint mode. The labels themselves define
 * the valid characters — letters, digits, and reserved mnemonics alike — so
 * any key that cannot extend the typed prefix toward a label exits.
 */
export function activeTransition(
  labels: readonly string[],
  typed: string,
  key: string,
): ActiveTransition {
  if (MODIFIER_KEYS.has(key)) return { kind: "ignore" };
  if (key === "Escape") return { kind: "exit" };
  if (key === "Backspace") return { kind: "retype", typed: typed.slice(0, -1) };
  const char = key.length === 1 ? key.toLowerCase() : "";
  if (char === "") return { kind: "exit" };
  const next = typed + char;
  const matching = labels.filter((label) => label.startsWith(next));
  if (matching.length === 0) return { kind: "exit" };
  const exact = matching.find((label) => label === next);
  if (exact !== undefined) return { kind: "activate", label: exact };
  return { kind: "retype", typed: next };
}

/** The keydown facts the idle-trigger decision reads. */
export interface IdleKey {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly editableTarget: boolean;
}

/**
 * True for `Cmd+Shift+F`, which opens hints from anywhere and, while a
 * scoped reprompt is up, replaces it with a whole-screen prompt. Matched by
 * code, since shift changes the reported key.
 */
export function isForceChord(
  key: Pick<IdleKey, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): boolean {
  return key.metaKey && key.shiftKey && !key.ctrlKey && !key.altKey && key.code === "KeyF";
}

/**
 * True when the keydown opens hint mode from idle. Plain `f` defers to an
 * editable target; the force chord does not, because bb autofocuses its
 * composer and would otherwise make hints unreachable without a click or an
 * Escape.
 */
export function isIdleTrigger(key: IdleKey): boolean {
  if (key.metaKey) return isForceChord(key);
  if (key.ctrlKey || key.altKey) return false;
  return key.key === "f" && !key.editableTarget;
}

/** The element facts the editable-target decision reads. */
export interface EditableProbe {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
}

/** True when typing belongs to the element, so `f` must reach it. */
export function isEditableProbe(probe: EditableProbe): boolean {
  const tag = probe.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (probe.isContentEditable) return true;
  if (probe.getAttribute("role") === "textbox") return true;
  if (probe.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (probe.closest('[role="textbox"]')) return true;
  return false;
}

/** The element facts the dropdown-trigger decision reads. */
export interface DropdownProbe {
  readonly tagName: string;
  getAttribute(name: string): string | null;
}

/**
 * True when activating the element opens an in-page popup worth reprompting
 * into. `dialog` counts because bb's model selector is a popover dialog full
 * of plain buttons. A native select renders its options in the OS picker,
 * outside the DOM, so it is not one.
 */
export function opensDropdown(probe: DropdownProbe): boolean {
  if (probe.tagName.toUpperCase() === "SELECT") return false;
  const haspopup = probe.getAttribute("aria-haspopup");
  if (haspopup === "menu" || haspopup === "listbox" || haspopup === "dialog") return true;
  if (haspopup === "true") return true;
  return probe.getAttribute("role") === "combobox";
}

/** The element facts the candidate decision reads, gathered off the DOM. */
export interface CandidateView {
  readonly clickableBeyondTabindex: boolean;
  readonly tabindex: string | null;
  readonly disabled: boolean;
  readonly insideAriaHidden: boolean;
  readonly insideQuietZone: boolean;
  readonly blockedByActiveAgent: boolean;
  readonly rect: { top: number; left: number; width: number; height: number };
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly display: string;
  readonly visibility: string;
  /**
   * Element.checkVisibility(), which sees ancestor opacity the computed
   * display/visibility strings miss; null where the API does not exist.
   */
  readonly visibleToUser: boolean | null;
}

/** True when the element deserves a hint marker. */
export function isViableCandidate(view: CandidateView): boolean {
  if (view.tabindex === "-1" && !view.clickableBeyondTabindex) return false;
  if (view.disabled || view.insideAriaHidden || view.insideQuietZone || view.blockedByActiveAgent) {
    return false;
  }
  if (view.rect.width <= 0 || view.rect.height <= 0) return false;
  if (view.rect.top + view.rect.height <= 0 || view.rect.left + view.rect.width <= 0) return false;
  if (view.rect.top >= view.viewportHeight || view.rect.left >= view.viewportWidth) return false;
  if (view.display === "none" || view.visibility !== "visible") return false;
  if (view.visibleToUser === false) return false;
  return true;
}

const CLICKABLE_SELECTORS = [
  "a[href]",
  "button",
  'input:not([type="hidden"])',
  "textarea",
  "select",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  "[onclick]",
] as const;
const CANDIDATE_SELECTOR = [...CLICKABLE_SELECTORS, "[tabindex]"].join(", ");
const NON_TABINDEX_SELECTOR = CLICKABLE_SELECTORS.join(", ");

// Hint-free regions. The conversation timeline rerenders and auto-scrolls
// while an agent streams, so its hints would be stale the moment they drew,
// and its per-message action bars are the bulk of a busy screen's clutter.
// Pierre's per-line action buttons ride the same exclusion. The context-window
// tracker is informational rather than navigation. closest() matches the
// element itself, so these selectors exclude each control proper.
const QUIET_ZONE_SELECTOR =
  '[data-timeline-row-list], [data-timeline-file-diff], [data-utility-button], [aria-label^="Context window "]';

// Radix layers that trap focus and aria-hide the rest of the page while open.
const OPEN_LAYER_SELECTOR =
  '[role="dialog"][data-bb-portaled-overlay], [role="menu"], [role="listbox"]';

// Covers bb's own thread links and any sidebar honoring bb's thread-shortcut
// contract (gtd-sidebar rows are `href="#"` anchors carrying the data attribute).
const THREAD_ROW_SELECTOR = 'a[href*="/threads/"], [data-sidebar-thread-shortcut-target]';

// gtd-sidebar parks a settle button beside each inbox row's anchor. It only
// shows on hover, but a dispatched pointer press reaches it either way.
const SETTLE_BUTTON_SELECTOR = 'button[aria-label="Settle thread"]';

// The conversation's top-level row list. Its scroller is a plain Tailwind
// `overflow-y-auto` div with no data attribute, found by walking up from here.
const CONVERSATION_LIST_SELECTOR = '[data-timeline-row-list="top-level"]';

/** How long after a keyboard thread switch self-focusing editors stay blurred. */
const NAVIGATION_FOCUS_GUARD_MS = 2000;

const COMPOSER_SELECTOR = "[data-app-composer]";
const COMPOSER_TEXTBOX_SELECTOR = '[data-app-composer] [role="textbox"]';
const COARSE_POINTER_QUERY = "(pointer: coarse)";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return isEditableProbe({
    tagName: target.tagName,
    isContentEditable: target instanceof HTMLElement && target.isContentEditable,
    getAttribute: (name) => target.getAttribute(name),
    closest: (selectors) => target.closest(selectors),
  });
}

function findActivePrimaryComposer(): HTMLElement | null {
  for (const composer of document.querySelectorAll<HTMLElement>(
    '[data-app-composer-role="primary"]',
  )) {
    if (composer.querySelector('button[aria-label="Stop run"]') !== null) return composer;
  }
  return null;
}

function isBlockedByActiveAgent(element: Element, activeComposer: HTMLElement | null): boolean {
  if (activeComposer === null) return false;
  if (element.matches('button[aria-label="Scroll to latest event"]')) return true;

  const footer = activeComposer.querySelector<HTMLElement>("[data-follow-up-composer-footer]");
  return footer?.firstElementChild?.contains(element) === true;
}

function candidateView(element: Element, activeComposer: HTMLElement | null): CandidateView {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    clickableBeyondTabindex: element.matches(NON_TABINDEX_SELECTOR),
    tabindex: element.getAttribute("tabindex"),
    disabled:
      element.matches(":disabled") ||
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true",
    insideAriaHidden: element.closest('[aria-hidden="true"]') !== null,
    insideQuietZone: element.closest(QUIET_ZONE_SELECTOR) !== null,
    blockedByActiveAgent: isBlockedByActiveAgent(element, activeComposer),
    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    display: style.display,
    visibility: style.visibility,
    visibleToUser:
      typeof element.checkVisibility === "function"
        ? element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        : null,
  };
}

interface ThreadRow {
  readonly id: string;
  readonly element: HTMLElement;
}

/**
 * The thread id a sidebar row opens: bb's own rows and gtd-sidebar rows carry
 * it as a data attribute, and older bb rows only in their href.
 */
function threadRowId(element: HTMLElement): string | null {
  const dataId = element.getAttribute("data-sidebar-thread-id");
  if (dataId) return dataId;
  const href = element.getAttribute("href");
  return href === null ? null : threadIdFromPath(href);
}

/**
 * Rendered sidebar thread rows in list order, one per thread. Rows scrolled
 * out of the sidebar's viewport still count, as they do for bb's own
 * previous/next commands; rows in a collapsed shelf or a hidden layer do not.
 */
function collectThreadRows(): ThreadRow[] {
  const rows: ThreadRow[] = [];
  const seen = new Set<string>();
  for (const element of document.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR)) {
    const id = threadRowId(element);
    if (id === null || seen.has(id)) continue;
    if (element.closest('[aria-hidden="true"]') !== null) continue;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility()) continue;
    seen.add(id);
    rows.push({ id, element });
  }
  return rows;
}

function findControl(selector: string): HTMLElement | null {
  const activeComposer = findActivePrimaryComposer();
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (isViableCandidate(candidateView(element, activeComposer))) return element;
  }
  return null;
}

/** Whether the user asked for reduced motion. jsdom has no matchMedia. */
function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The nearest scrolling ancestor of the conversation's row list, or null. */
function findConversationScrollArea(): HTMLElement | null {
  const list = document.querySelector<HTMLElement>(CONVERSATION_LIST_SELECTOR);
  for (let element = list?.parentElement; element; element = element.parentElement) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return element;
  }
  return null;
}

function collectTargets(scope: ParentNode): HTMLElement[] {
  const targets: HTMLElement[] = [];
  const activeComposer = findActivePrimaryComposer();
  for (const element of scope.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) {
    if (isViableCandidate(candidateView(element, activeComposer))) targets.push(element);
  }
  return targets;
}

function topLevelFact(element: HTMLElement): TopLevelFact {
  const reserved = RESERVED_CONTROLS.find((control) => element.matches(control.selector));
  const textReserved = TEXT_CONTROLS.find(
    (control) => element.matches(control.selector) && element.textContent?.trim() === control.text,
  );
  return {
    reservedChar: reserved?.char ?? textReserved?.char ?? null,
    isThreadRow: element.matches(THREAD_ROW_SELECTOR),
  };
}

function dropdownScopeKind(trigger: HTMLElement): ScopedKind {
  if (trigger.matches('[data-app-composer] button[aria-label^="Provider, model"]')) {
    return "provider-model";
  }
  if (trigger.matches("[data-app-composer] [data-promptbox-project-control]")) {
    return "project";
  }
  if (trigger.matches('[data-app-composer] button[aria-label="Permission mode"]')) {
    return "permission";
  }
  return "generic";
}

function scopedFact(kind: ScopedKind, element: HTMLElement, root: HTMLElement): ScopedFact {
  if (kind === "provider-model") {
    if (isTextEntry(element)) return { role: "search" };
    if (element.getAttribute("role") === "switch") return { role: "other" };
    const choices = root.querySelector<HTMLElement>('[class~="overflow-y-auto"]');
    return { role: choices?.contains(element) === false ? "provider" : "choice" };
  }
  if (kind === "project") {
    if (isTextEntry(element)) return { role: "other" };
    const text = (element.textContent ?? "").trim().toLowerCase();
    if (text.includes("new project")) return { role: "new-project" };
    if (text.includes("work in a project")) return { role: "projectless" };
    return { role: "project" };
  }
  if (kind === "permission") {
    return { role: isTextEntry(element) ? "other" : "permission" };
  }
  return { role: "other" };
}

function findPopupRoot(trigger: HTMLElement): HTMLElement | null {
  const id = trigger.getAttribute("aria-controls");
  const controlled = id ? document.getElementById(id) : null;
  if (controlled) return controlled;
  const popups = document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]');
  return popups.item(popups.length - 1);
}

function createMarker(target: HTMLElement): HTMLElement {
  const marker = document.createElement("div");
  marker.className = "vimium-hint-marker";
  const rect = target.getBoundingClientRect();
  const left = Math.min(Math.max(rect.left, 0), Math.max(window.innerWidth - 24, 0));
  const top = Math.min(Math.max(rect.top, 0), Math.max(window.innerHeight - 16, 0));
  marker.style.left = `${left}px`;
  marker.style.top = `${top}px`;
  return marker;
}

function renderMarker(hint: Hint, typedCount: number): void {
  const typedSpan = document.createElement("span");
  typedSpan.className = "vimium-hint-typed";
  typedSpan.textContent = hint.label.slice(0, typedCount);
  const restSpan = document.createElement("span");
  restSpan.textContent = hint.label.slice(typedCount);
  hint.marker.replaceChildren(typedSpan, restSpan);
}

function isTextEntry(target: HTMLElement): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "textbox") return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
  return false;
}

function activate(
  target: HTMLElement,
  focusTextEntry: (target: HTMLElement) => void = (entry) => entry.focus(),
): void {
  if (isTextEntry(target)) {
    focusTextEntry(target);
    return;
  }
  if (typeof target.focus === "function") target.focus({ preventScroll: true });
  const rect = target.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
    detail: 1,
  };
  // The leading pointermove matters: Radix ignores an item's pointerup until
  // the pointer has moved after the gesture that opened its popup.
  const sequence = ["pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const type of sequence) {
    const event =
      type.startsWith("pointer") && typeof PointerEvent === "function"
        ? new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true, pointerType: "mouse" })
        : new MouseEvent(type, init);
    target.dispatchEvent(event);
  }
}

export function mountLinkHints(context: PluginContentScriptContext): PluginContentScriptDisposer {
  const releasePassiveComposerFocus = window.matchMedia?.(COARSE_POINTER_QUERY).matches !== true;
  let mode: HintMode = { kind: "idle" };
  let container: HTMLElement | null = null;
  let popupWatch: number | null = null;
  let composerFocusAllowed = false;
  let composerPointerOrTabFocusAllowed = false;
  let composerFocusWindow: number | null = null;
  // While set in the future, editable elements that take focus on their own
  // are blurred. A thread opened from the keyboard remounts the thread's
  // panels, and an editor there (the docs panel's markdown editor autofocuses)
  // would otherwise swallow the next `[` or `]`. The user's next pointer
  // press or key ends the guard early.
  let editableFocusGuardUntil = 0;
  const scroller = createScroller();

  function guardEditableFocus(): void {
    editableFocusGuardUntil = performance.now() + NAVIGATION_FOCUS_GUARD_MS;
  }

  function withComposerFocusAllowed(action: () => void): void {
    const wasAllowed = composerFocusAllowed;
    composerFocusAllowed = true;
    try {
      action();
    } finally {
      composerFocusAllowed = wasAllowed;
    }
  }

  // Pointer focus and the browser's Tab focus happen after their triggering
  // event listener returns. Keep that one default action open until the next
  // task, while programmatic focus from bb remains blocked.
  function allowComposerFocusForDefaultAction(): void {
    composerPointerOrTabFocusAllowed = true;
    if (composerFocusWindow !== null) window.clearTimeout(composerFocusWindow);
    composerFocusWindow = window.setTimeout(() => {
      composerPointerOrTabFocusAllowed = false;
      composerFocusWindow = null;
    }, 0);
  }

  function focusTextEntry(target: HTMLElement): void {
    if (!target.matches(COMPOSER_TEXTBOX_SELECTOR)) {
      target.focus();
      return;
    }
    withComposerFocusAllowed(() => target.focus());
  }

  function onFocusIn(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches(COMPOSER_TEXTBOX_SELECTOR)) {
      if (!releasePassiveComposerFocus) return;
      if (composerFocusAllowed || composerPointerOrTabFocusAllowed) return;
      target.blur();
      return;
    }
    if (performance.now() < editableFocusGuardUntil && isEditableTarget(target)) target.blur();
  }

  function onPointerDown(event: PointerEvent): void {
    editableFocusGuardUntil = 0;
    const target = event.target;
    if (target instanceof Element && target.closest(COMPOSER_SELECTOR) !== null) {
      allowComposerFocusForDefaultAction();
    }
  }

  function exit(): void {
    if (popupWatch !== null) {
      window.clearInterval(popupWatch);
      popupWatch = null;
    }
    mode = { kind: "idle" };
    container?.remove();
    container = null;
  }

  function exitIfActive(): void {
    if (mode.kind === "active") exit();
  }

  function show(
    targets: readonly HTMLElement[],
    labels: readonly string[],
    scopeRoot: HTMLElement | null,
    refocusComposer: boolean,
    scopeKind: ScopedKind,
  ): void {
    const layer = document.createElement("div");
    layer.className = "vimium-hint-layer";
    const hints = targets.map((target, index): Hint => {
      const hint: Hint = { label: labels[index] ?? "", target, marker: createMarker(target) };
      renderMarker(hint, 0);
      layer.appendChild(hint.marker);
      return hint;
    });
    document.body.appendChild(layer);
    container = layer;
    mode = { kind: "active", hints, typed: "", scopeRoot, refocusComposer, scopeKind };
    if (scopeRoot !== null) watchPopup(scopeRoot);
  }

  function enterTopLevel(): boolean {
    const targets = collectTargets(document);
    if (targets.length === 0) return false;
    show(targets, assignTopLevelLabels(targets.map(topLevelFact)), null, false, "generic");
    return true;
  }

  function enterScoped(
    root: HTMLElement,
    refocusComposer: boolean,
    scopeKind: ScopedKind,
  ): boolean {
    const targets = collectTargets(root);
    if (targets.length === 0) return false;
    const labels = assignScopedLabels(
      scopeKind,
      targets.map((target) => scopedFact(scopeKind, target, root)),
    );
    show(targets, labels, root, refocusComposer, scopeKind);
    return true;
  }

  // The force chord means the whole screen, but an open popup layer aria-hides
  // everything outside itself, so a prompt over one would only find its own
  // controls. Radix layers dismiss on a document-level Escape; send one, wait
  // for the layers to unmount, then prompt. With no layer open this stays
  // synchronous. If a layer refuses to close, prompt anyway.
  function enterTopLevelDismissing(): boolean {
    const layers = [...document.querySelectorAll<HTMLElement>(OPEN_LAYER_SELECTOR)];
    if (layers.length === 0) return enterTopLevel();
    dispatchEscape();
    let attempts = 0;
    const poll = (): void => {
      if (context.signal.aborted || mode.kind !== "idle") return;
      attempts += 1;
      if (layers.some((layer) => layer.isConnected) && attempts < 8) {
        if (attempts % 3 === 0) dispatchEscape();
        window.setTimeout(poll, 60);
        return;
      }
      enterTopLevel();
    };
    window.setTimeout(poll, 60);
    return true;
  }

  function dispatchEscape(): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  // A click outside or an app-level Escape unmounts the popup without any key
  // reaching the hint listener, so a scoped prompt has to see the removal
  // itself.
  function watchPopup(root: HTMLElement): void {
    popupWatch = window.setInterval(() => {
      if (!root.isConnected) exitIfActive();
    }, 100);
  }

  // A direct key does what its hint would: press the control, and follow a
  // dropdown into a scoped prompt so the pick is one more key away. True when
  // the key did something, so the caller knows whether to swallow it.
  function runDirectShortcut(shortcut: DirectShortcut): boolean {
    switch (shortcut.kind) {
      case "focus-composer": {
        const textbox = document.querySelector<HTMLElement>(COMPOSER_TEXTBOX_SELECTOR);
        if (textbox === null) return false;
        withComposerFocusAllowed(() => textbox.focus());
        return true;
      }
      case "control": {
        const control = findControl(shortcut.selector);
        if (control === null) return false;
        activate(control, focusTextEntry);
        if (!isTextEntry(control) && opensDropdown(control)) scheduleReprompt(control);
        return true;
      }
      case "thread-step": {
        const rows = collectThreadRows();
        const index = adjacentThreadIndex(
          rows.map((row) => row.id),
          threadIdFromPath(window.location.pathname),
          shortcut.step,
        );
        const row = index === null ? undefined : rows[index];
        if (row === undefined) return false;
        activate(row.element, focusTextEntry);
        guardEditableFocus();
        return true;
      }
      case "settle-thread": {
        const activeId = threadIdFromPath(window.location.pathname);
        if (activeId === null) return false;
        const row = collectThreadRows().find((candidate) => candidate.id === activeId);
        const settle =
          row?.element.parentElement?.querySelector<HTMLElement>(SETTLE_BUTTON_SELECTOR);
        if (!settle) return false;
        activate(settle, focusTextEntry);
        return true;
      }
      case "scroll": {
        const area = findConversationScrollArea();
        if (area === null) return false;
        if (shortcut.motion !== "bottom") {
          // bb's bottom-anchored scroll body only treats a scroll as the user
          // leaving the bottom when it saw recent wheel, touch, pointer, or
          // arrow-key intent; without one a `k` during a streaming reply snaps
          // back to the bottom on the next chunk. A synthetic wheel is exactly
          // how bb classifies a mouse wheel. `J` needs none: landing on the
          // max scrollTop makes bb's own handler re-attach to the bottom.
          area.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: shortcut.motion === "down" ? SCROLL_STEP_PX : -SCROLL_STEP_PX,
              bubbles: true,
            }),
          );
        }
        const amount = scrollAmountFor(shortcut.motion, {
          scrollTop: area.scrollTop,
          scrollHeight: area.scrollHeight,
          clientHeight: area.clientHeight,
        });
        if (amount !== 0) {
          if (prefersReducedMotion()) area.scrollBy({ top: amount, behavior: "instant" });
          else scroller.scrollBy(area, amount, shortcut.motion !== "bottom");
        }
        return true;
      }
    }
  }

  function applyTyped(typed: string): void {
    if (mode.kind !== "active") return;
    mode = { ...mode, typed };
    for (const hint of mode.hints) {
      const matches = hint.label.startsWith(typed);
      hint.marker.style.display = matches ? "" : "none";
      if (matches) renderMarker(hint, typed.length);
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    scroller.noteKeydown({ code: event.code, repeat: event.repeat });
    if (!MODIFIER_KEYS.has(event.key)) editableFocusGuardUntil = 0;
    if (
      mode.kind === "idle" &&
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      allowComposerFocusForDefaultAction();
    }
    if (mode.kind === "idle") {
      const shortcut = directShortcutFor({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget: isEditableTarget(event.target),
      });
      if (shortcut !== null) {
        // A shortcut with nothing to act on leaves the key to bb.
        if (!runDirectShortcut(shortcut)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    if (mode.kind === "idle") {
      const trigger = isIdleTrigger({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget: isEditableTarget(event.target),
      });
      if (!trigger) return;
      const opened = isForceChord(event) ? enterTopLevelDismissing() : enterTopLevel();
      if (!opened) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (isForceChord(event)) {
      exit();
      if (enterTopLevelDismissing()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // Any other chord belongs to the browser or to bb; exit without swallowing it.
      exit();
      return;
    }
    const action = activeTransition(
      mode.hints.map((hint) => hint.label),
      mode.typed,
      event.key,
    );
    if (action.kind === "ignore") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action.kind === "exit") {
      exit();
      return;
    }
    if (action.kind === "retype") {
      applyTyped(action.typed);
      return;
    }
    const chosen = mode.hints.find((hint) => hint.label === action.label);
    const scopeRoot = mode.scopeRoot;
    const wantsComposerBack = mode.refocusComposer;
    const scopeKind = mode.scopeKind;
    exit();
    if (!chosen) return;
    activate(chosen.target, focusTextEntry);
    if (isTextEntry(chosen.target)) return;
    if (chosen.target.matches(THREAD_ROW_SELECTOR)) guardEditableFocus();
    if (opensDropdown(chosen.target)) {
      scheduleReprompt(chosen.target);
      return;
    }
    if (scopeRoot !== null) afterScopedPick(scopeRoot, wantsComposerBack, scopeKind);
  }

  // The popup portals in and animates open after the click, so poll briefly
  // and reprompt with hints scoped to it once it holds viable options.
  function scheduleReprompt(trigger: HTMLElement): void {
    const refocusComposer = trigger.closest(COMPOSER_SELECTOR) !== null;
    const scopeKind = dropdownScopeKind(trigger);
    let attempts = 0;
    const poll = (): void => {
      if (context.signal.aborted || mode.kind !== "idle") return;
      const root = findPopupRoot(trigger);
      if (root && enterScoped(root, refocusComposer, scopeKind)) return;
      attempts += 1;
      if (attempts < 10) window.setTimeout(poll, 60);
    };
    window.setTimeout(poll, 60);
  }

  // A pick from a popup either closes it or leaves it open: bb's model dialog
  // stays up after a pick, and its Providers tab swaps the option list. Follow
  // the popup — once it closes, hand focus back to the composer when the
  // trigger came from there; while it stays open, re-prompt scoped to it.
  function afterScopedPick(
    popup: HTMLElement,
    refocusComposer: boolean,
    scopeKind: ScopedKind,
  ): void {
    let ticks = 0;
    const poll = (): void => {
      if (context.signal.aborted || mode.kind !== "idle") return;
      if (!popup.isConnected) {
        if (refocusComposer) assertComposerFocus();
        return;
      }
      ticks += 1;
      if (ticks < 6) {
        window.setTimeout(poll, 80);
        return;
      }
      enterScoped(popup, refocusComposer, scopeKind);
    };
    window.setTimeout(poll, 80);
  }

  // Radix hands focus back to the trigger as its popup closes, so a single
  // focus() would be stolen right back; restate the composer's claim for a
  // few ticks.
  function assertComposerFocus(): void {
    let ticks = 0;
    const claim = (): void => {
      if (context.signal.aborted) return;
      const textbox = document.querySelector<HTMLElement>(COMPOSER_TEXTBOX_SELECTOR);
      if (!textbox) return;
      if (document.activeElement !== textbox) {
        withComposerFocusAllowed(() => textbox.focus());
      }
      ticks += 1;
      if (ticks < 6) window.setTimeout(claim, 80);
    };
    claim();
  }

  function onKeyup(event: KeyboardEvent): void {
    scroller.noteKeyup(event.code);
  }

  function onBlur(): void {
    scroller.cancel();
    exitIfActive();
  }

  // Markers are pinned to rects measured at entry, so a scroll that moves a
  // hinted target makes them stale — but the timeline's streaming auto-scroll
  // moves no hint (it is a quiet zone) and must not dismiss the prompt. A
  // window scroll reaches here with the document as target and always exits.
  function onScroll(event: Event): void {
    if (mode.kind !== "active") return;
    const scrolled = event.target;
    if (scrolled instanceof Element && !mode.hints.some((hint) => scrolled.contains(hint.target))) {
      return;
    }
    exit();
  }

  window.addEventListener("focusin", onFocusIn, { capture: true, signal: context.signal });
  window.addEventListener("pointerdown", onPointerDown, {
    capture: true,
    signal: context.signal,
  });
  window.addEventListener("keydown", onKeydown, { capture: true, signal: context.signal });
  window.addEventListener("keyup", onKeyup, { capture: true, signal: context.signal });
  window.addEventListener("scroll", onScroll, { capture: true, signal: context.signal });
  window.addEventListener("resize", exitIfActive, { signal: context.signal });
  window.addEventListener("blur", onBlur, { signal: context.signal });

  // The content script can mount after React has already applied autofocus.
  const active = document.activeElement;
  if (
    releasePassiveComposerFocus &&
    active instanceof HTMLElement &&
    active.matches(COMPOSER_TEXTBOX_SELECTOR)
  ) {
    active.blur();
  }

  return () => {
    if (composerFocusWindow !== null) window.clearTimeout(composerFocusWindow);
    exit();
  };
}
