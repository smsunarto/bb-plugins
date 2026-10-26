import { BB_THEME_TOKENS, htmlRenderTheme } from "../shared/html-render.ts";
import type { BbThemeTokens, HtmlRenderTheme } from "../shared/html-render.ts";

/** The page theme for bb's current appearance, read from its live tokens. */
export function readBbTheme(root: HTMLElement = document.documentElement): HtmlRenderTheme {
  const style = getComputedStyle(root);
  const tokens: Partial<Record<keyof BbThemeTokens, string>> = {};
  for (const name of BB_THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  return htmlRenderTheme(tokens, root.classList.contains("dark") ? "dark" : "light");
}

export function sameTheme(a: HtmlRenderTheme, b: HtmlRenderTheme): boolean {
  if (a.appearance !== b.appearance) return false;
  const names = Object.keys(a.variables);
  return (
    names.length === Object.keys(b.variables).length &&
    names.every((name) => a.variables[name] === b.variables[name])
  );
}

/** Calls `onChange` when bb switches theme, coalesced to one style read per frame. */
export function observeBbTheme(onChange: (theme: HtmlRenderTheme) => void): () => void {
  const root = document.documentElement;
  let theme = readBbTheme(root);
  let pending = 0;
  const sync = () => {
    pending = 0;
    const next = readBbTheme(root);
    if (sameTheme(theme, next)) return;
    theme = next;
    onChange(next);
  };
  // bb swaps theme classes on <html> and may rewrite a theme <style> in place.
  const observer = new MutationObserver(() => {
    pending ||= requestAnimationFrame(sync);
  });
  observer.observe(root, { attributes: true });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    cancelAnimationFrame(pending);
  };
}
