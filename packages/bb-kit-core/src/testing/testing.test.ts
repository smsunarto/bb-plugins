import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom, stubClient, stubHostContext } from "./testing.ts";

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

test("stubClient passes a stubbed RPC through with its result", async () => {
  const client = stubClient<FakeClient>({
    ping: async ({ n }) => ({ pong: n + 1 }),
  });
  assert.deepEqual(await client.ping({ n: 41 }), { pong: 42 });
});

test("stubClient throws the naming error when an unstubbed RPC is called", () => {
  const client = stubClient<FakeClient>({});
  // Accessing the RPC is fine — only calling it throws.
  const missing = client.missing;
  assert.equal(typeof missing, "function");
  assert.throws(missing, {
    message: 'stubClient: RPC "missing" was called without a stub',
  });
});

test("stubHostContext supplies bb with sdk and a kv storage stub", async () => {
  const host = stubHostContext();
  assert.equal(Object.keys(host).join(), "bb");
  assert.equal(Object.isFrozen(host), true);
  assert.equal(await host.bb.storage.kv.get("missing"), undefined);
  await host.bb.storage.kv.set("k", 1);
  await host.bb.storage.kv.delete("k");
  assert.deepEqual(await host.bb.storage.kv.list(), []);
});

test("stubHostContext mints a fresh bb per call and preserves a passed one", () => {
  assert.notEqual(stubHostContext().bb, stubHostContext().bb);
  const bb = { sdk: { tag: 1 }, storage: { kv: {} } };
  const host = stubHostContext({ bb: bb as never });
  assert.equal(host.bb, bb);
  assert.equal(host.bb.sdk, bb.sdk);
});

test("stubClient is await-safe — then and symbol keys read as undefined", async () => {
  const client = stubClient<FakeClient>({});
  const raw = client as unknown as Record<string | symbol, unknown>;
  assert.equal(raw["then"], undefined);
  assert.equal(raw[Symbol.iterator], undefined);
  // A non-thenable awaits to itself instead of hanging.
  assert.equal(await client, client);
});
