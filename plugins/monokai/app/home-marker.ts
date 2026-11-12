import { useLayoutEffect } from "react";

// bb marks no route on the page, so the New thread screen announces itself:
// bb mounts homepage sections only there, and this one draws nothing. The
// theme hides the page outlines while the attribute is present.
const HOME_ATTRIBUTE = "data-monokai-home";

interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

// Split panes can show two New thread screens at once; the mark stays until
// the last one leaves.
const counts = new WeakMap<AttributeTarget, number>();

export function markHome(target: AttributeTarget): () => void {
  counts.set(target, (counts.get(target) ?? 0) + 1);
  target.setAttribute(HOME_ATTRIBUTE, "");
  return () => {
    const remaining = (counts.get(target) ?? 1) - 1;
    counts.set(target, remaining);
    if (remaining === 0) target.removeAttribute(HOME_ATTRIBUTE);
  };
}

/** Layout effect: the mark lands before the first paint, so no edge flashes. */
export function HomeMarker(): null {
  useLayoutEffect(() => markHome(document.documentElement), []);
  return null;
}
