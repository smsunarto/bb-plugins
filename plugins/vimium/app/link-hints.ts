// @smsunarto/bb-plugin-vimium — Vimium-style `f` link hints over the bb app shell.
//
// One content script, one capture-phase keydown listener, one state machine:
// idle until a plain `f` lands outside an editable target — or `Cmd+Shift+F`
// lands anywhere, since bb keeps its composer focused — then a marker per
// visible clickable element until the typed characters pick one — or Escape,
// Backspace past the start, a non-hint key, a scroll, a resize, or a blur
// exits. A hint that lands on a dropdown trigger re-prompts once the popup
// appears, with hints scoped to its options and labels ordered for the home
// row. The transitions and predicates are pure functions so they test
// without a DOM; only mounting, marker drawing, and activation touch one.

import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import { DROPDOWN_ALPHABET, HINT_ALPHABET, hintLabels } from "./hint-labels.ts";

type HintMode =
  | { kind: "idle" }
  | { kind: "active"; hints: readonly Hint[]; typed: string };

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

/** What one keydown does to active hint mode, given the labels on screen. */
export function activeTransition(
  labels: readonly string[],
  typed: string,
  key: string,
  alphabet: string = HINT_ALPHABET,
): ActiveTransition {
  if (MODIFIER_KEYS.has(key)) return { kind: "ignore" };
  if (key === "Escape") return { kind: "exit" };
  if (key === "Backspace") return { kind: "retype", typed: typed.slice(0, -1) };
  const char = key.length === 1 ? key.toLowerCase() : "";
  if (char === "" || !alphabet.includes(char)) return { kind: "exit" };
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
 * True when the keydown opens hint mode from idle. Plain `f` defers to an
 * editable target; `Cmd+Shift+F` does not, because bb autofocuses its
 * composer and would otherwise make hints unreachable without a click or an
 * Escape. Matched by code, since shift changes the reported key.
 */
export function isIdleTrigger(key: IdleKey): boolean {
  if (key.metaKey) {
    return key.shiftKey && !key.ctrlKey && !key.altKey && key.code === "KeyF";
  }
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
 * True when activating the element opens an in-page dropdown worth
 * reprompting into. A native select renders its options in the OS picker,
 * outside the DOM, so it is not one.
 */
export function opensDropdown(probe: DropdownProbe): boolean {
  if (probe.tagName.toUpperCase() === "SELECT") return false;
  const haspopup = probe.getAttribute("aria-haspopup");
  if (haspopup === "menu" || haspopup === "listbox" || haspopup === "true") return true;
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

  function exit(): void {
    mode = { kind: "idle" };
    container?.remove();
    container = null;
  }

  function exitIfActive(): void {
    if (mode.kind === "active") exit();
  }

  function enter(scope: ParentNode = document, alphabet: string = HINT_ALPHABET): boolean {
    const targets = collectTargets(scope);
    if (targets.length === 0) return false;
    const labels = hintLabels(targets.length, alphabet);
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
    mode = { kind: "active", hints, typed: "" };
    return true;
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
      if (!enter()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // A chord belongs to the browser or to bb; exit without swallowing it.
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
    exit();
    if (!chosen) return;
    activate(chosen.target);
    if (!isTextEntry(chosen.target) && opensDropdown(chosen.target)) {
      scheduleReprompt(chosen.target);
    }
  }

  // The popup portals in and animates open after the click, so poll briefly
  // and reprompt with hints scoped to it once it holds viable options.
  function scheduleReprompt(trigger: HTMLElement): void {
    let attempts = 0;
    const poll = (): void => {
      if (context.signal.aborted || mode.kind !== "idle") return;
      const root = findPopupRoot(trigger);
      if (root && enter(root, DROPDOWN_ALPHABET)) return;
      attempts += 1;
      if (attempts < 10) window.setTimeout(poll, 60);
    };
    window.setTimeout(poll, 60);
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
