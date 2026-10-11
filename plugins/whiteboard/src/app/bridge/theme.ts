import type {
  ReviewDiffLayout,
  ReviewDisposable,
  ReviewTheme,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { DIFF_LAYOUT_STORAGE_KEY } from "../../shared/contracts/panel.ts";

/**
 * Whiteboard theme and Diff layout preference for the bridge (design §3.8).
 * The Whiteboard is always light, whatever bb's appearance: the mount puts the
 * canvas in bb's `.light` token scope, so the theme never changes.
 */
export function currentTheme(): ReviewTheme {
  return "light";
}

export function onDidChangeTheme(): ReviewDisposable {
  return { dispose() {} };
}

const layoutListeners = new Set<(layout: ReviewDiffLayout) => void>();

function readLayout(value: string | null): ReviewDiffLayout {
  return value === "unified" ? "unified" : "split";
}

/** App-wide, as upstream's `diffEditor.renderSideBySide`: split unless the reader chose unified. */
export function currentDiffLayout(): ReviewDiffLayout {
  try {
    return readLayout(window.localStorage.getItem(DIFF_LAYOUT_STORAGE_KEY));
  } catch {
    return "split";
  }
}

export async function setDiffLayout(layout: ReviewDiffLayout): Promise<void> {
  try {
    window.localStorage.setItem(DIFF_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Storage can be unavailable in an embedded browser. The choice still
    // reaches every open surface in this window.
  }
  // `storage` events only reach other windows, so tell this one directly.
  for (const listener of Array.from(layoutListeners)) listener(layout);
}

export function onDidChangeDiffLayout(
  listener: (layout: ReviewDiffLayout) => void,
): ReviewDisposable {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DIFF_LAYOUT_STORAGE_KEY) listener(readLayout(event.newValue));
  };
  layoutListeners.add(listener);
  window.addEventListener("storage", onStorage);
  return {
    dispose() {
      layoutListeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    },
  };
}
