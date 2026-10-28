/*
 * The jsdom every app test renders into. Import it before anything that
 * loads React DOM (so `@testing-library/react` and the app come in through
 * `await import(...)` after it): React DOM decides at load time whether the
 * document supports `input` events, and without them controlled fields break.
 */
import { installDom } from "@bb-plugins/testing";

installDom();

// Bun's native Event and AbortSignal classes survive installDom, but jsdom's
// EventTarget only takes its own. Radix dispatches CustomEvents from its focus
// and dismiss layers, and the Changes tab drops listeners through a signal.
for (const name of ["Event", "CustomEvent", "AbortController", "AbortSignal"] as const) {
  (globalThis as Record<string, unknown>)[name] = window[name];
}

// jsdom ships no ResizeObserver, and Radix measures popovers with one.
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= InertResizeObserver;

// Pierre's diff element styles its shadow root with constructed style sheets,
// which jsdom does not implement.
const sheet = (window as unknown as { CSSStyleSheet: { prototype: Record<string, unknown> } })
  .CSSStyleSheet.prototype;
sheet["replaceSync"] ??= () => {};
const shadow = window.ShadowRoot.prototype as unknown as Record<string, unknown>;
if (!("adoptedStyleSheets" in shadow)) shadow["adoptedStyleSheets"] = [];
