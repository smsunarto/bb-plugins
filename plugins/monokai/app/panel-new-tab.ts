import { useEffect, useLayoutEffect, useRef } from "react";
import {
  experimental_useAppPanel,
  experimental_usePanelTabs,
  type ExperimentalPanelTabs,
  type PluginContentScriptContext,
} from "@get-bb/plugin-sdk/app";

/**
 * Opening a thread's right panel with bb's toggle shows a new tab, as it does
 * on bb's New thread screen. bb's thread view instead restores the last
 * selected tab, or Info.
 *
 * - **Toggle intent:** the panel's tab list cannot tell a toggle from a
 *   control that opens the tab already selected, such as Source Control's
 *   header button or the composer's Info link. The `panel-new-tab` content
 *   script records a click on bb's toggle button (`aria-label` "Show right
 *   panel…") or a press of the shortcut in that button's `aria-keyshortcuts`.
 *   Only an open within {@link INTENT_MS} of one is redirected. The command
 *   palette, a phone swipe, and every other opener keep bb's choice.
 * - **Transition:** the panel goes from closed to open with the same tab
 *   selected (bb restored it) or nothing selected before (bb fell back to Info).
 * - **Existing new tab:** selected through the SDK. bb keeps one new tab per
 *   panel (a fixed id), so at most one is open.
 * - **No new tab:** the SDK cannot create one, so the hook asks the content
 *   script to press bb's own `button[data-panel-new-tab]` in the thread's panel
 *   (DOM hack; private contract: the button's `data-panel-new-tab`, inside the
 *   desktop panel's `thread-detail-secondary-panel` id or, under 768px, the
 *   `secondary-panel-shelf` test id). When the button is missing or ambiguous,
 *   the restored tab stays.
 *
 * The hook only reads and selects tabs through the SDK; every DOM read, press,
 * and listener belongs to the content script and ends with its signal.
 */
const TOGGLE_BUTTON = 'button[aria-label^="Show right panel"]';
/** How long after a toggle press its panel open counts as the toggle's. */
const INTENT_MS = 500;
/** The desktop panel, or bb's phone shelf, which hosts the panel under 768px. */
const PANEL = ':is([id^="thread-detail-secondary-panel"], [data-testid="secondary-panel-shelf"])';
const NEW_TAB_BUTTON = `${PANEL} button[data-panel-new-tab]`;
/** Frames to wait for bb to mount the panel's tab strip after it opens. */
const BUTTON_WAIT_FRAMES = 6;

export type PanelOpenRedirect =
  | { kind: "none" }
  | { kind: "select"; key: string }
  | { kind: "create" };

/** What to do when the panel's tabs change from `previous` to `next`. */
export function panelOpenRedirect(
  previous: ExperimentalPanelTabs | null,
  next: ExperimentalPanelTabs,
): PanelOpenRedirect {
  if (previous === null || previous.open || !next.open) return { kind: "none" };
  // bb's empty list, published while no panel is mounted: not a toggle.
  if (previous.tabs.length === 0) return { kind: "none" };
  const restored = next.selectedKey === previous.selectedKey;
  const fellBackToInfo = previous.selectedKey === null && selectedDetailKind(next) === "info";
  if (!restored && !fellBackToInfo) return { kind: "none" };
  if (selectedDetailKind(next) === "new-tab") return { kind: "none" };
  const newTab = next.tabs.find((tab) => tab.detail.kind === "new-tab");
  return newTab === undefined ? { kind: "create" } : { kind: "select", key: newTab.key };
}

function selectedDetailKind(tabs: ExperimentalPanelTabs) {
  return tabs.tabs.find((tab) => tab.key === tabs.selectedKey)?.detail.kind ?? null;
}

/**
 * Presses bb's new-tab button once it mounts, at most {@link BUTTON_WAIT_FRAMES}
 * frames later; presses nothing when it never appears or more than one does.
 */
function pressNewTabButton(doc: Document, stopped: () => boolean, frames: number) {
  if (stopped()) return;
  const buttons = doc.querySelectorAll<HTMLButtonElement>(NEW_TAB_BUTTON);
  if (buttons.length === 1) {
    buttons[0]!.click();
    return;
  }
  if (buttons.length > 1 || frames <= 0) return;
  doc.defaultView?.requestAnimationFrame(() => pressNewTabButton(doc, stopped, frames - 1));
}

/** When bb's panel toggle was last pressed, from {@link mountPanelNewTab}. */
let lastToggleAt = Number.NEGATIVE_INFINITY;
/** Mounted {@link usePanelOpensToNewTab} hooks; no thread view, no shortcut lookups. */
let redirectHooks = 0;
/** The mounted content script's press of bb's new-tab button, if any. */
let pressNewTab: ((cancelled: () => boolean) => void) | null = null;

/**
 * Asks the mounted {@link mountPanelNewTab} to press bb's new-tab button in the
 * open panel; does nothing without one. `cancelled` stops a press still waiting
 * for the button.
 */
export function pressPanelNewTab(cancelled: () => boolean): void {
  pressNewTab?.(cancelled);
}

/**
 * Whether `event` presses `shortcut`, an `aria-keyshortcuts` value such as
 * `Control+\` or `Meta+Shift+B`. Several space-separated shortcuts may be
 * listed; any one matches.
 */
export function matchesKeyShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  shortcut: string,
): boolean {
  return shortcut.split(" ").some((one) => {
    const parts = one.split("+");
    const key = parts.pop()?.toLowerCase();
    if (!key) return false;
    const modifiers = new Set(parts.map((part) => part.toLowerCase()));
    if (event.ctrlKey !== modifiers.has("control")) return false;
    if (event.metaKey !== modifiers.has("meta")) return false;
    if (event.altKey !== modifiers.has("alt")) return false;
    if (event.shiftKey !== modifiers.has("shift")) return false;
    const code = event.code.replace(/^(Key|Digit)/, "").toLowerCase();
    return event.key.toLowerCase() === key || code === key;
  });
}

/**
 * Content script: records presses of bb's panel toggle, by pointer or by its
 * shortcut, and presses bb's new-tab button when the hook asks. Capture-phase
 * listeners on the document, because bb handles the shortcut at the window
 * from anywhere on the page and the button may re-render under the pointer.
 * A modified key press reads the shortcut only while a thread view is mounted,
 * from the toggle button it last found; it looks the button up again only once
 * bb has replaced it.
 */
export function mountPanelNewTab({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  if (signal.aborted) return () => {};
  let toggle: Element | null = null;
  const mark = () => {
    lastToggleAt = performance.now();
  };
  const onClick = (event: MouseEvent) => {
    const hit = event.target instanceof Element ? event.target.closest(TOGGLE_BUTTON) : null;
    if (hit === null) return;
    toggle = hit;
    mark();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // A shortcut needs a modifier, and only a thread view redirects its open.
    if (redirectHooks === 0 || (!event.ctrlKey && !event.metaKey && !event.altKey)) return;
    if (toggle?.isConnected !== true) toggle = doc.querySelector(TOGGLE_BUTTON);
    const shortcut = toggle?.getAttribute("aria-keyshortcuts");
    if (shortcut && matchesKeyShortcut(event, shortcut)) mark();
  };
  const press = (cancelled: () => boolean) =>
    pressNewTabButton(doc, () => signal.aborted || cancelled(), BUTTON_WAIT_FRAMES);
  doc.addEventListener("click", onClick, { capture: true, signal });
  doc.addEventListener("keydown", onKeyDown, { capture: true, signal });
  pressNewTab = press;
  return () => {
    doc.removeEventListener("click", onClick, { capture: true });
    doc.removeEventListener("keydown", onKeyDown, { capture: true });
    if (pressNewTab === press) pressNewTab = null;
    lastToggleAt = Number.NEGATIVE_INFINITY;
    toggle = null;
  };
}

/** Makes a toggle-open of this thread's right panel land on a new tab. */
export function usePanelOpensToNewTab(): void {
  const panel = experimental_useAppPanel();
  const tabs = experimental_usePanelTabs();
  const previous = useRef<ExperimentalPanelTabs | null>(null);
  const unmounted = useRef({ cancelled: false });

  useEffect(() => {
    const signal = { cancelled: false };
    unmounted.current = signal;
    redirectHooks += 1;
    return () => {
      signal.cancelled = true;
      redirectHooks -= 1;
    };
  }, []);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = tabs;
    if (performance.now() - lastToggleAt > INTENT_MS) return;
    const redirect = panelOpenRedirect(before, tabs);
    if (redirect.kind === "none") return;
    // One redirect per press, so a later open in the window is bb's.
    lastToggleAt = Number.NEGATIVE_INFINITY;
    if (redirect.kind === "select") panel.selectTab(redirect.key);
    else {
      const signal = unmounted.current;
      pressPanelNewTab(() => signal.cancelled);
    }
  }, [panel, tabs]);
}
