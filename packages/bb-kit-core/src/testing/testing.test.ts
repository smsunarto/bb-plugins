import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./testing.ts";

type DomGlobals = {
  window?: Record<string, unknown>;
  document?: {
    body: unknown;
    createElement(tag: string): { tagName: string };
  };
  HTMLElement?: unknown;
};

const globals = globalThis as unknown as DomGlobals;

test("installDom puts a working document on globalThis", () => {
  installDom();
  assert.notEqual(globals.window, undefined);
  assert.notEqual(globals.document, undefined);
  assert.notEqual(globals.HTMLElement, undefined);
  assert.notEqual(globals.document?.body, undefined);
  assert.equal(globals.document?.createElement("div").tagName, "DIV");
});

test("installDom is idempotent — the first DOM wins", () => {
  installDom();
  const first = globals.window;
  const firstDocument = globals.document;
  installDom();
  assert.equal(globals.window, first);
  assert.equal(globals.document, firstDocument);
});
