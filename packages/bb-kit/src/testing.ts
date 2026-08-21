import { createRequire } from "node:module";

/** Public surface of `@bb-kit/core/testing` (§1, §8). */

/**
 * Build a full client from only the procedures a test stubs (§8).
 * Stubbed keys pass through. Any other procedure reads as a function
 * that throws, naming the procedure, when CALLED — so a command
 * reaching past its stubs fails loudly instead of awaiting undefined.
 * `then` and symbol keys read as undefined so the client never becomes
 * a thenable (mirroring query.ts's clientProxy — "then" would hang
 * `await client`).
 */
export function stubClient<C extends object>(partial: Partial<C>): C {
  return new Proxy(partial, {
    get(target, property) {
      if (typeof property !== "string" || property === "then") {
        return undefined;
      }
      if (property in target) {
        return (target as Record<string, unknown>)[property];
      }
      return () => {
        throw new Error(`stubClient: procedure "${property}" was called without a stub`);
      };
    },
  }) as unknown as C;
}

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
