import { createRequire } from "node:module";

/** Public surface of `@bb-kit/core/testing` (§1, §8). */

/**
 * Install a jsdom document onto `globalThis` for tier-3 tests (§8).
 * Idempotent — the first call wins, later calls are no-ops (including
 * when some other harness already installed a DOM). Call it BEFORE
 * importing anything that touches the DOM at module scope. Throws a
 * clear error naming the `jsdom` devDependency when jsdom cannot be
 * resolved.
 */
export function installDom(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  if (target["window"] !== undefined && target["document"] !== undefined) {
    return;
  }

  const require = createRequire(import.meta.url);
  let jsdomModule: unknown;
  try {
    jsdomModule = require("jsdom");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `installDom() could not resolve jsdom. Add "jsdom" to your plugin's devDependencies and install it. (${message})`,
    );
  }

  const { JSDOM } = jsdomModule as {
    JSDOM: new (
      html: string,
      options: { url: string; pretendToBeVisual: boolean },
    ) => { window: Record<string, unknown> };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const domWindow = dom.window;

  // Copy the window's own properties onto globalThis, skipping anything
  // node already provides (navigator, fetch, Event, ...) — node's
  // versions may sit behind non-writable getters and react/RTL are
  // happy with either. `window` and `document` are set explicitly.
  for (const name of Object.getOwnPropertyNames(domWindow)) {
    if (name in globalThis) {
      continue;
    }
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: domWindow[name],
    });
  }
  target["window"] = domWindow;
  target["document"] = domWindow["document"];
}
