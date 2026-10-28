import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/** BB marks its dark theme with a `dark` class on the root element. */
export function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * The colour an element is painted on, as #rrggbb: its ancestors'
 * backgrounds composited, outermost first. Null until the element mounts.
 * `dark` re-reads it when BB's theme flips.
 */
export function useBackdropColor(element: RefObject<HTMLElement | null>, dark: boolean): string | null {
  const [color, setColor] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (element.current !== null) setColor(backdropColor(element.current, dark));
  }, [element, dark]);
  return color;
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

function backdropColor(element: HTMLElement, dark: boolean): string {
  const layers: string[] = [];
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    const background = getComputedStyle(current).backgroundColor;
    if (!TRANSPARENT.test(background)) layers.unshift(background);
  }
  // A canvas composites the layers and reads any colour syntax (BB's are oklch) back as sRGB.
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context === null) return dark ? "#000000" : "#ffffff";
  context.canvas.width = 1;
  context.canvas.height = 1;
  for (const layer of [dark ? "#000000" : "#ffffff", ...layers]) {
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
