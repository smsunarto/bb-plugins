/**
 * Escape for every Source Control dialog, confirm row, menu and panel.
 *
 * bb leaves a plugin page on an Escape that nothing claimed, and it sees the
 * key before a React handler can stop it. So one capture listener on window
 * claims Escape for the innermost open layer (the last one opened): a modal
 * layer wherever focus is, any other only while focus is inside it. A picker
 * of bb's own (the new-thread composer's menus), which opens outside the
 * plugin, gets Escape first. When a layer closes, focus goes back to what
 * had it before the layer opened, or to the control drawn in its place, if
 * focus would otherwise be lost.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type Layer = {
  scope: RefObject<Element | null>;
  escape: RefObject<() => void>;
  modal: boolean;
};

const layers: Layer[] = [];
/**
 * The last two elements to take focus. A layer that takes focus as it mounts,
 * or whose trigger unmounts, finds its opener here: a removed element fires
 * no focusout.
 */
let focused: Element | null = null;
let focusedBefore: Element | null = null;
let installed = false;

/** bb's own menus and popovers, which it portals outside the plugin. */
const FOREIGN_PICKER = "[data-radix-popper-content-wrapper], [role=menu], [role=listbox]";
const ROOT = "[data-bb-plugin='source-control']";

/** A tooltip is not a picker: Escape goes past it to the layer it decorates. */
function foreignPickerOpen(): boolean {
  for (const node of document.querySelectorAll(FOREIGN_PICKER))
    if (!node.closest(ROOT) && !node.querySelector("[role=tooltip]")) return true;
  return false;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  if (layers.length === 0 || foreignPickerOpen()) return;
  const target = event.target instanceof Node ? event.target : null;
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    const node = layer.scope.current;
    if (!layer.modal && !(node && target && node.contains(target))) continue;
    event.preventDefault();
    event.stopPropagation();
    layer.escape.current();
    return;
  }
}

function onFocusIn(event: FocusEvent) {
  if (!(event.target instanceof Element) || event.target === focused) return;
  focusedBefore = focused;
  focused = event.target;
}

function install() {
  if (installed) return;
  installed = true;
  // Capture: bb's own Escape must not see a claimed key first.
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn, true);
}

/** Test-only: forget every layer and the listeners' state. */
export function resetEscapeLayers() {
  layers.length = 0;
  focused = null;
  focusedBefore = null;
}

/**
 * Claims Escape for `scope` while `open`, calling `onEscape`. Modal layers
 * claim it wherever focus is. Called unconditionally, so focus history is
 * tracked before the layer opens.
 */
export function useEscapeLayer(
  scope: RefObject<Element | null>,
  onEscape: () => void,
  { open = true, modal = false }: { open?: boolean; modal?: boolean } = {},
) {
  const escape = useRef(onEscape);
  useLayoutEffect(() => {
    escape.current = onEscape;
  });
  useLayoutEffect(install, []);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const node = scope.current;
    const opener =
      [document.activeElement, focused, focusedBefore].find(
        (each) => each && each !== document.body && !node?.contains(each),
      ) ?? null;
    const layer: Layer = { scope, escape, modal };
    layers.push(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      // After the commit: the opener may be disabled, inert behind a modal
      // dialog, or replaced until then.
      queueMicrotask(() => {
        if (!opener || !focusLost(node)) return;
        (opener.isConnected ? (opener as HTMLElement) : successor(opener))?.focus();
      });
    };
  }, [open, modal, scope]);
}

function focusLost(scope: Element | null): boolean {
  const now = document.activeElement;
  if (!now || now === document.body || !now.isConnected) return true;
  if (!scope?.isConnected || !scope.contains(now)) return false;
  // A scope may wrap its own trigger (the send tray), which stays visible
  // and keeps focus; anything else inside a closed layer is hidden.
  return typeof now.checkVisibility !== "function" || !now.checkVisibility();
}

/** The control drawn in place of `gone`: the one Source Control control with its tag and label. */
function successor(gone: Element): HTMLElement | null {
  const label = gone.getAttribute("aria-label");
  const text = gone.textContent?.trim();
  const tag = gone.tagName.toLowerCase();
  const matches = [...document.querySelectorAll<HTMLElement>(`${ROOT} ${tag}`)].filter((node) =>
    label ? node.getAttribute("aria-label") === label : node.textContent?.trim() === text,
  );
  return matches.length === 1 ? matches[0]! : null;
}

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), [contenteditable='true']";

/**
 * Keeps keyboard focus inside a dialog that is not on the top layer, where
 * the page behind stays focusable. bb's own pickers, portaled outside, may
 * take focus; anything else on the page sends it back into the dialog, to
 * the end it left from.
 */
export function useFocusContainment(scope: RefObject<Element | null>, open = true) {
  useEffect(() => {
    if (!open) return undefined;
    let backwards = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") backwards = event.shiftKey;
    };
    const onFocusIn = (event: FocusEvent) => {
      const node = scope.current;
      const target = event.target;
      if (!node || !(target instanceof Element) || node.contains(target)) return;
      if (target.closest(FOREIGN_PICKER)) return;
      // The first (or last) that really takes focus: a match may be hidden.
      const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      for (const candidate of backwards ? focusable.toReversed() : focusable) {
        candidate.focus();
        if (document.activeElement === candidate) return;
      }
      (node as HTMLElement).focus();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open, scope]);
}
