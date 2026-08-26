/**
 * Open a URL in bb's thread-side in-app browser from a plugin that cannot
 * call the host's `openTab({ kind: "browser" })`.
 *
 * The plugin SDK has no browser opener, and `UrlOpenRoutingProvider` does not
 * wrap the left sidebar. A click with `target="_blank"` is sent to the OS
 * browser by Electron. This module writes the same localStorage blob the host
 * hydrates on panel mount (`atomWithStorage` re-reads on mount, and a
 * synthetic `storage` event covers an already-mounted thread) and persists
 * the tab through `threads.tabs` so the host's server reconcile does not
 * wipe it.
 */

export const FIXED_PANEL_TABS_STATE_STORAGE_PREFIX = "bb.thread.fixedPanelTabsState";
export const FIXED_PANEL_TABS_STATE_STORAGE_VERSION = 1;
export const IN_APP_BROWSER_MAX_URL_LENGTH = 4096;
export const IN_APP_BROWSER_MAX_TITLE_LENGTH = 1024;

export interface InAppBrowserTab {
  environmentId: string | null;
  id: string;
  kind: "browser";
  title: string | null;
  url: string;
}

export interface FixedPanelTabsState {
  lastUsedAt: number;
  secondary: {
    activeTabId: string | null;
    isOpen: boolean;
    tabs: unknown[];
  };
  version: typeof FIXED_PANEL_TABS_STATE_STORAGE_VERSION;
}

export interface ModifierKeyEvent {
  altKey: boolean;
  button?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function hasAnyModifierKey(event: ModifierKeyEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/** Left-click with no modifier goes in-app; anything else keeps the OS browser. */
export function shouldDeferToSystemBrowser(event: ModifierKeyEvent): boolean {
  return (event.button !== undefined && event.button !== 0) || hasAnyModifierKey(event);
}

export function isDesktopInAppBrowserAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const desktop = (window as Window & { bbDesktop?: { browser?: unknown } }).bbDesktop;
  return desktop?.browser != null;
}

export function panelStorageKey(threadId: string): string {
  return `${FIXED_PANEL_TABS_STATE_STORAGE_PREFIX}-${encodeURIComponent(threadId.trim())}-${FIXED_PANEL_TABS_STATE_STORAGE_VERSION}`;
}

export function clipInAppBrowserText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function createInAppBrowserTab({
  environmentId,
  instanceId = crypto.randomUUID(),
  title,
  url,
}: {
  environmentId: string | null;
  instanceId?: string;
  title: string;
  url: string;
}): InAppBrowserTab {
  const clippedTitle = clipInAppBrowserText(title.trim(), IN_APP_BROWSER_MAX_TITLE_LENGTH);
  return {
    environmentId,
    id: [
      "browser",
      encodeURIComponent(instanceId),
      encodeURIComponent(environmentId ?? "none"),
    ].join(":"),
    kind: "browser",
    title: clippedTitle.length > 0 ? clippedTitle : "Pull request",
    url: clipInAppBrowserText(url, IN_APP_BROWSER_MAX_URL_LENGTH),
  };
}

export function upsertBrowserTab<T extends { id: string; kind: string; url?: string }>(
  tabs: readonly T[],
  tab: InAppBrowserTab,
): { tab: T | InAppBrowserTab; tabs: Array<T | InAppBrowserTab> } {
  const existing = tabs.find(
    (candidate) => candidate.kind === "browser" && candidate.url === tab.url,
  );
  if (existing !== undefined) {
    return { tab: existing, tabs: [...tabs] };
  }
  return { tab, tabs: [...tabs, tab] };
}

export function parsePanelState(storedValue: string | null): FixedPanelTabsState | null {
  if (storedValue === null) return null;
  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== FIXED_PANEL_TABS_STATE_STORAGE_VERSION) return null;
    if (typeof record.secondary !== "object" || record.secondary === null) return null;
    const secondary = record.secondary as Record<string, unknown>;
    if (!Array.isArray(secondary.tabs) || typeof secondary.isOpen !== "boolean") return null;
    const activeTabId = secondary.activeTabId;
    if (activeTabId !== null && typeof activeTabId !== "string") return null;
    const lastUsedAt = record.lastUsedAt;
    if (typeof lastUsedAt !== "number" || !Number.isInteger(lastUsedAt) || lastUsedAt < 0) {
      return null;
    }
    return {
      lastUsedAt,
      secondary: {
        activeTabId,
        isOpen: secondary.isOpen,
        tabs: secondary.tabs,
      },
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
    };
  } catch {
    return null;
  }
}

type BrowserTabCandidate = {
  environmentId?: unknown;
  id: string;
  kind: string;
  title?: unknown;
  url?: string;
};

function asInAppBrowserTab(candidate: BrowserTabCandidate, fallback: InAppBrowserTab): InAppBrowserTab {
  if (candidate.kind !== "browser" || typeof candidate.url !== "string") return fallback;
  const title = candidate.title;
  const environmentId = candidate.environmentId;
  return {
    environmentId:
      typeof environmentId === "string" || environmentId === null
        ? environmentId
        : fallback.environmentId,
    id: candidate.id,
    kind: "browser",
    title: typeof title === "string" && title.length > 0 ? title : fallback.title,
    url: candidate.url,
  };
}

export function openBrowserTabInPanelState(
  state: FixedPanelTabsState | null,
  tab: InAppBrowserTab,
  now: number,
): { state: FixedPanelTabsState; tab: InAppBrowserTab } {
  const currentTabs = (state?.secondary.tabs ?? []) as BrowserTabCandidate[];
  const next = upsertBrowserTab(currentTabs, tab);
  const opened = asInAppBrowserTab(next.tab, tab);
  return {
    tab: opened,
    state: {
      lastUsedAt: now,
      secondary: {
        activeTabId: opened.id,
        isOpen: true,
        tabs: next.tabs,
      },
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
    },
  };
}

export function serializePanelState(state: FixedPanelTabsState): string {
  return JSON.stringify(state);
}

const REVEAL_RETRY_DELAYS_MS = [50, 250] as const;

/**
 * Write the host's per-thread panel blob and poke jotai. Retries cover the
 * window where `threads.tabs` realtime reconcile can briefly replace the
 * strip before the PUT is visible to the query cache.
 */
export function revealInAppBrowserTab({
  tab,
  threadId,
}: {
  tab: InAppBrowserTab;
  threadId: string;
}): void {
  const apply = (): void => {
    if (typeof window === "undefined") return;
    const key = panelStorageKey(threadId);
    const current = parsePanelState(window.localStorage.getItem(key));
    const { state } = openBrowserTabInPanelState(current, tab, Date.now());
    const serialized = serializePanelState(state);
    window.localStorage.setItem(key, serialized);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: serialized,
        storageArea: window.localStorage,
      }),
    );
  };

  apply();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(apply);
  }
  for (const delay of REVEAL_RETRY_DELAYS_MS) {
    window.setTimeout(apply, delay);
  }
}
