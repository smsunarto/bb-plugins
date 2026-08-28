import { createRequire } from "node:module";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

/** Importing this module installs jsdom and the SDK's test runtime as a side
 *  effect. `@get-bb/plugin-sdk/app` binds `globalThis.__bbPluginRuntime` while
 *  it evaluates, so a test that renders a slot must import this file above
 *  `../app.tsx`; static imports evaluate in source order, which is what keeps
 *  the ordering readable instead of hiding it in a dynamic import. */
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

installTestPluginRuntime();
