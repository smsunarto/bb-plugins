import { useLayoutEffect } from "react";

// bb marks no route on the page, so the New thread screen announces itself:
// bb mounts homepage sections only there, and this one draws nothing. The
// theme uses the attribute for the phone halftone backdrop and right-panel toggle.
const HOME_ATTRIBUTE = "data-monokai-home";

export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

// Split panes can show two of a screen at once; each mark stays until the
// last one leaves.
const counts = new WeakMap<AttributeTarget, Map<string, number>>();

/** Sets `attribute` on `target` until every caller has called its disposer. */
export function markPage(target: AttributeTarget, attribute: string): () => void {
  const byName = counts.get(target) ?? new Map<string, number>();
  counts.set(target, byName);
  byName.set(attribute, (byName.get(attribute) ?? 0) + 1);
  target.setAttribute(attribute, "");
  return () => {
    const remaining = (byName.get(attribute) ?? 1) - 1;
    byName.set(attribute, remaining);
    if (remaining === 0) target.removeAttribute(attribute);
  };
}

export function markHome(target: AttributeTarget): () => void {
  return markPage(target, HOME_ATTRIBUTE);
}

/** Layout effect: the mark lands before the first paint, so the phone backdrop and toggle never flash. */
export function HomeMarker(): null {
  useLayoutEffect(() => markHome(document.documentElement), []);
  return null;
}
