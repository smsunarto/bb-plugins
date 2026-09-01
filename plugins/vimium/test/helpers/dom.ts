import { createRequire } from "node:module";

/** Importing this module installs jsdom globals as a side effect, the same
 *  way amp's test helper does. Import it above anything that touches DOM. */
const target = globalThis as unknown as Record<string, unknown>;
if (target["window"] === undefined || target["document"] === undefined) {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (
      html: string,
      options: { pretendToBeVisual: boolean; url: string },
    ) => { window: Record<string, unknown> };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (name in globalThis) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
      writable: true,
    });
  }
  target["window"] = dom.window;
  target["document"] = dom.window["document"];
}
