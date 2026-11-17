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
 *   header button or the composer's Info link. A content script records a
 *   click on bb's toggle button (`aria-label` "Show right panel…") or a press
 *   of the shortcut in that button's `aria-keyshortcuts`. Only an open within
 *   {@link INTENT_MS} of one is redirected. The command palette, a phone swipe,
 *   and every other opener keep bb's choice.
 * - **Transition:** the panel goes from closed to open with the same tab
 *   selected (bb restored it) or nothing selected before (bb fell back to Info).
 * - **Existing new tab:** selected through the SDK. bb keeps one new tab per
 *   panel (a fixed id), so at most one is open.
 * - **No new tab:** the SDK cannot create one, so the hook presses bb's own
 *   `button[data-panel-new-tab]` in the thread's panel (DOM hack; private
 *   contract: the `thread-detail-secondary-panel` id prefix and the button's
 *   `data-panel-new-tab`). When the button is missing or ambiguous, the
 *   restored tab stays.
 */
const TOGGLE_BUTTON = 'button[aria-label^="Show right panel"]';
/** How long after a toggle press its panel open counts as the toggle's. */
const INTENT_MS = 500;
const PANEL = '[id^="thread-detail-secondary-panel"]';
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

/** Presses bb's new-tab button once it mounts; gives up when it never appears. */
function pressNewTabButton(doc: Document, signal: { cancelled: boolean }, frames: number) {
  if (signal.cancelled) return;
  const buttons = doc.querySelectorAll<HTMLButtonElement>(NEW_TAB_BUTTON);
  if (buttons.length === 1) {
    buttons[0]!.click();
    return;
  }
  if (buttons.length > 1 || frames <= 0) return;
  doc.defaultView?.requestAnimationFrame(() => pressNewTabButton(doc, signal, frames - 1));
}

/** When bb's panel toggle was last pressed, from {@link mountPanelToggleIntent}. */
let lastToggleAt = Number.NEGATIVE_INFINITY;

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
 * shortcut. Capture-phase listeners on the document, because bb handles the
 * shortcut at the window and the button may re-render under the pointer.
 */
export function mountPanelToggleIntent({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  if (signal.aborted) return () => {};
  const mark = () => {
    lastToggleAt = performance.now();
  };
  const onClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest(TOGGLE_BUTTON) !== null) mark();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // A shortcut needs a modifier; plain typing never queries the page.
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    const shortcut = doc.querySelector(TOGGLE_BUTTON)?.getAttribute("aria-keyshortcuts");
    if (shortcut && matchesKeyShortcut(event, shortcut)) mark();
  };
  doc.addEventListener("click", onClick, { capture: true, signal });
  doc.addEventListener("keydown", onKeyDown, { capture: true, signal });
  return () => {
    doc.removeEventListener("click", onClick, { capture: true });
    doc.removeEventListener("keydown", onKeyDown, { capture: true });
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
    return () => {
      signal.cancelled = true;
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
    else pressNewTabButton(document, unmounted.current, BUTTON_WAIT_FRAMES);
  }, [panel, tabs]);
}
