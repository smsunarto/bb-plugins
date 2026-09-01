// @smsunarto/bb-plugin-vimium — Vimium-style `f` link hints over the bb app shell.
//
// One content script, one capture-phase keydown listener, one state machine:
// idle until a plain `f` lands outside an editable target, then a marker per
// visible clickable element until the typed characters pick one — or Escape,
// Backspace past the start, a non-hint key, a scroll, a resize, or a blur
// exits. The transitions and predicates are pure functions so they test
// without a DOM; only mounting, marker drawing, and activation touch one.

import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import { HINT_ALPHABET, hintLabels } from "./hint-labels.ts";

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

function collectTargets(): HTMLElement[] {
  const targets: HTMLElement[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) {
    if (isViableCandidate(candidateView(element))) targets.push(element);
  }
  return targets;
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
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
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

  function enter(): boolean {
    const targets = collectTargets();
    if (targets.length === 0) return false;
    const labels = hintLabels(targets.length);
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
      if (event.key !== "f" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
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
    if (chosen) activate(chosen.target);
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
