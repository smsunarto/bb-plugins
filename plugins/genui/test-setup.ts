import { afterAll, vi } from "vitest";

// jsdom and Node lack the browser feature detection read at module load.
if (typeof matchMedia === "undefined") {
  vi.stubGlobal("matchMedia", (media: string): MediaQueryList => ({
    media,
    matches: false,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
}
if (typeof CSS === "undefined") {
  vi.stubGlobal("CSS", { supports: () => false });
}

/** Vitest's jsdom environment exposes the JSDOM instance; absent in node-environment test files. */
declare const jsdom: { window: Window } | undefined;
// Node 25+ has its own global localStorage (undefined without --localstorage-file), which hides
// jsdom's: jsdom test files get jsdom's back on every Node version. Defined rather than stubbed,
// so a test file's vi.unstubAllGlobals() keeps it.
if (typeof jsdom !== "undefined") {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, enumerable: true, writable: true, value: jsdom.window.localStorage });
}
afterAll(() => vi.unstubAllGlobals());
