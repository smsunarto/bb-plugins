import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, stubClient } from "./testing.ts";

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

type FakeClient = {
  ping: (input: { n: number }) => Promise<{ pong: number }>;
  missing: () => Promise<{ ok: boolean }>;
};

test("stubClient passes a stubbed procedure through with its result", async () => {
  const client = stubClient<FakeClient>({
    ping: async ({ n }) => ({ pong: n + 1 }),
  });
  assert.deepEqual(await client.ping({ n: 41 }), { pong: 42 });
});

test("stubClient throws the naming error when an unstubbed procedure is called", () => {
  const client = stubClient<FakeClient>({});
  // Accessing the procedure is fine — only calling it throws.
  const missing = client.missing;
  assert.equal(typeof missing, "function");
  assert.throws(missing, {
    message: 'stubClient: procedure "missing" was called without a stub',
  });
});

test("stubClient is await-safe — then and symbol keys read as undefined", async () => {
  const client = stubClient<FakeClient>({});
  const raw = client as unknown as Record<string | symbol, unknown>;
  assert.equal(raw["then"], undefined);
  assert.equal(raw[Symbol.iterator], undefined);
  // A non-thenable awaits to itself instead of hanging.
  assert.equal(await client, client);
});
