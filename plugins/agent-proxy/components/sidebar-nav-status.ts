import type { CoreStatus } from "../server";

/**
 * Paints core state onto this plugin's row in bb's main sidebar.
 *
 * bb renders that row itself from the `navPanel` registration — title and icon
 * are read once, and no slot accepts a live component — so a content script is
 * the only way to reflect state there. We locate the row by its label and set
 * one data attribute on it; `app.css` owns the visuals.
 *
 * Everything here degrades to a no-op: a missing container, a renamed row, or a
 * failed request leaves the sidebar exactly as the host drew it.
 */
const PLUGIN_ID = "agent-proxy";
const NAV_ROWS = '[data-testid="plugin-nav-sidebar-items"]';
const STATE_ATTR = "data-agent-proxy-state";
const POLL_MS = 5_000;

/** Broadcast by `useCoreStatus` so a mounted panel updates the row instantly. */
export const STATUS_EVENT = "agent-proxy:core-status";

export type CoreState = CoreStatus["state"];

/** The row's sibling "…" button carries this suffix; skip it when matching. */
function isOptionsButton(button: Element): boolean {
  return button.getAttribute("aria-label")?.endsWith("panel options") === true;
}

function findNavRow(container: Element, title: string): HTMLElement | null {
  for (const button of container.querySelectorAll("button")) {
    if (isOptionsButton(button)) continue;
    if (button.textContent?.trim() === title) return button;
  }
  return null;
}

async function fetchState(signal: AbortSignal): Promise<CoreState | null> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal,
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: CoreStatus };
  return body.result?.state ?? null;
}

export function mountSidebarNavStatus({ title, signal }: { title: string; signal: AbortSignal }) {
  let state: CoreState | null = null;
  let container: Element | null = null;
  let row: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Scoped to the nav container, never the document: the row moves when the
  // user reorders or hides panels, but chat streaming must not trigger us.
  const observer = new MutationObserver(() => paint());

  function paint() {
    const nextContainer = document.querySelector(NAV_ROWS);
    if (nextContainer !== container) {
      observer.disconnect();
      container = nextContainer;
      if (container) observer.observe(container, { childList: true, subtree: true });
    }

    const nextRow = container ? findNavRow(container, title) : null;
    if (nextRow !== row) {
      row?.removeAttribute(STATE_ATTR);
      row = nextRow;
    }
    if (!row) return;
    if (state) row.setAttribute(STATE_ATTR, state);
    else row.removeAttribute(STATE_ATTR);
  }

  function apply(next: CoreState | null) {
    if (next === state) {
      paint(); // the row itself may have moved
      return;
    }
    state = next;
    paint();
  }

  const onPush = (event: Event) => {
    const detail = (event as CustomEvent<CoreState>).detail;
    if (typeof detail === "string") apply(detail);
  };
  window.addEventListener(STATUS_EVENT, onPush, { signal });

  // The push above only fires while a panel is mounted, so poll as the floor.
  const tick = async () => {
    if (signal.aborted) return;
    if (!document.hidden) {
      try {
        apply(await fetchState(signal));
      } catch {
        // Transient: keep the last known state and try again next tick.
      }
    } else {
      paint();
    }
    if (!signal.aborted) timer = setTimeout(() => void tick(), POLL_MS);
  };
  void tick();

  return () => {
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
    row?.removeAttribute(STATE_ATTR);
    row = null;
    container = null;
  };
}
