import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Promise<Response>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    return handler(url);
  }) as typeof globalThis.fetch;
  return requested;
}

test("reports running when local NoVNC answers 200", async () => {
  const requested = stubFetch(async () => new Response("ok", { status: 200 }));
  const host = experimental_createHostEntryHarness(hostEntry);

  assert.deepEqual(await host.experimental_call("checkNovnc", {}), { running: true });
  assert.deepEqual(requested, ["http://127.0.0.1:6080/vnc.html"]);
  await host.experimental_dispose();
});

test("reports not running with detail on a non-200 answer", async () => {
  stubFetch(async () => new Response("nope", { status: 404 }));
  const host = experimental_createHostEntryHarness(hostEntry);

  assert.deepEqual(await host.experimental_call("checkNovnc", {}), {
    running: false,
    detail: "HTTP 404",
  });
  await host.experimental_dispose();
});

test("reports not running with detail when the probe throws", async () => {
  stubFetch(async () => {
    throw new Error("connection refused");
  });
  const host = experimental_createHostEntryHarness(hostEntry);

  assert.deepEqual(await host.experimental_call("checkNovnc", {}), {
    running: false,
    detail: "connection refused",
  });
  await host.experimental_dispose();
});
