// @smsunarto/bb-plugin-vimium — Vimium-style `f` link hints over the bb app shell.
//
// One content script, one capture-phase keydown listener, one state machine:
// idle until a plain `f` lands outside an editable target — or `Cmd+Shift+F`
// lands anywhere, since bb keeps its composer focused — then a marker per
// visible clickable element until the typed characters pick one — or Escape,
// Backspace past the start, a non-hint key, a scroll, a resize, or a blur
// exits. Built-in composer controls keep pinned single-character labels and
// sidebar thread rows count 1-9; everything else gets two-character labels.
// A hint that lands on a dropdown trigger re-prompts once the popup appears,
// with hints scoped to its options and labels ordered for the home row; the
// scoped prompt follows the popup (exiting when it is dismissed), yields to
// `Cmd+Shift+F` for a fresh whole-screen prompt, and hands focus back to the
// composer after a pick from one of the composer's own dropdowns. The
// transitions and predicates are pure functions so they test without a DOM;
// only mounting, marker drawing, and activation touch one.

import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import {
  DROPDOWN_ALPHABET,
  RESERVED_COMPOSER_CONTROLS,
  assignTopLevelLabels,
  hintLabels,
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
  if (view.disabled || view.insideAriaHidden) return false;
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
  "[onclick]",
] as const;
const CANDIDATE_SELECTOR = [...CLICKABLE_SELECTORS, "[tabindex]"].join(", ");
const NON_TABINDEX_SELECTOR = CLICKABLE_SELECTORS.join(", ");

// Covers bb's own thread links and any sidebar honoring bb's thread-shortcut
// contract (gtd-sidebar rows are `href="#"` anchors carrying the data attribute).
const THREAD_ROW_SELECTOR = 'a[href*="/threads/"], [data-sidebar-thread-shortcut-target]';

const COMPOSER_SELECTOR = "[data-app-composer]";
const COMPOSER_TEXTBOX_SELECTOR = '[data-app-composer] [role="textbox"]';

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

function candidateView(element: Element): CandidateView {
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

function collectTargets(scope: ParentNode): HTMLElement[] {
  const targets: HTMLElement[] = [];
  for (const element of scope.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) {
    if (isViableCandidate(candidateView(element))) targets.push(element);
  }
  return targets;
}

function topLevelFact(element: HTMLElement): TopLevelFact {
  const reserved = RESERVED_COMPOSER_CONTROLS.find((control) =>
    element.matches(control.selector),
  );
  return {
    reservedChar: reserved?.char ?? null,
    isThreadRow: element.matches(THREAD_ROW_SELECTOR),
  };
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
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
  return false;
}

function activate(target: HTMLElement): void {
  if (isTextEntry(target)) {
    target.focus();
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

export function mountLinkHints(
  context: PluginContentScriptContext,
): PluginContentScriptDisposer {
  let mode: HintMode = { kind: "idle" };
  let container: HTMLElement | null = null;
  let popupWatch: number | null = null;

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
    mode = { kind: "active", hints, typed: "", scopeRoot, refocusComposer };
    if (scopeRoot !== null) watchPopup(scopeRoot);
  }

  function enterTopLevel(): boolean {
    const targets = collectTargets(document);
    if (targets.length === 0) return false;
    show(targets, assignTopLevelLabels(targets.map(topLevelFact)), null, false);
    return true;
  }

  function enterScoped(root: HTMLElement, refocusComposer: boolean): boolean {
    const targets = collectTargets(root);
    if (targets.length === 0) return false;
    show(targets, hintLabels(targets.length, DROPDOWN_ALPHABET), root, refocusComposer);
    return true;
  }

  // A click outside or an app-level Escape unmounts the popup without any key
  // reaching the hint listener, so a scoped prompt has to see the removal
  // itself.
  function watchPopup(root: HTMLElement): void {
    popupWatch = window.setInterval(() => {
      if (!root.isConnected) exitIfActive();
    }, 100);
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
      if (!enterTopLevel()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (isForceChord(event)) {
      exit();
      if (enterTopLevel()) {
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
    exit();
    if (!chosen) return;
    activate(chosen.target);
    if (isTextEntry(chosen.target)) return;
    if (opensDropdown(chosen.target)) {
      scheduleReprompt(chosen.target);
      return;
    }
    if (scopeRoot !== null && wantsComposerBack) scheduleComposerRefocus(scopeRoot);
  }

  // The popup portals in and animates open after the click, so poll briefly
  // and reprompt with hints scoped to it once it holds viable options.
  function scheduleReprompt(trigger: HTMLElement): void {
    const refocusComposer = trigger.closest(COMPOSER_SELECTOR) !== null;
    let attempts = 0;
    const poll = (): void => {
      if (context.signal.aborted || mode.kind !== "idle") return;
      const root = findPopupRoot(trigger);
      if (root && enterScoped(root, refocusComposer)) return;
      attempts += 1;
      if (attempts < 10) window.setTimeout(poll, 60);
    };
    window.setTimeout(poll, 60);
  }

  // Wait for the popup to actually close before claiming focus: bb's model
  // dialog stays open after a pick, and its focus trap owns focus until then.
  // Once it closes, Radix hands focus back to the trigger, so a single
  // focus() would be stolen right back; restate the composer's claim for a
  // few ticks instead.
  function scheduleComposerRefocus(popup: HTMLElement): void {
    let waitTicks = 0;
    let assertTicks = 0;
    const poll = (): void => {
      if (context.signal.aborted) return;
      if (popup.isConnected) {
        waitTicks += 1;
        if (waitTicks < 12) window.setTimeout(poll, 80);
        return;
      }
      const textbox = document.querySelector<HTMLElement>(COMPOSER_TEXTBOX_SELECTOR);
      if (!textbox) return;
      if (document.activeElement !== textbox) textbox.focus();
      assertTicks += 1;
      if (assertTicks < 6) window.setTimeout(poll, 80);
    };
    window.setTimeout(poll, 80);
  }

  window.addEventListener("keydown", onKeydown, { capture: true, signal: context.signal });
  // Markers are pinned to rects measured at entry; any of these makes them stale.
  window.addEventListener("scroll", exitIfActive, { capture: true, signal: context.signal });
  window.addEventListener("resize", exitIfActive, { signal: context.signal });
  window.addEventListener("blur", exitIfActive, { signal: context.signal });

  return () => {
    exit();
  };
}
