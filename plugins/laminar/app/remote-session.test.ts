import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  prepareRemoteSession,
  REMOTE_SESSION_URL,
  requiresConnectSession,
} from "./remote-session.ts";

test("recognizes BB Connect dashboard shares", () => {
  assert.equal(requiresConnectSession("https://scott--5668.getbb.app/"), true);
  assert.equal(requiresConnectSession("https://app.lmnr.ai/"), false);
  assert.equal(requiresConnectSession("http://127.0.0.1:5668/"), false);
  assert.equal(requiresConnectSession("http://localhost:5668/"), false);
});

test("prepares the browser session through the local plugin route", async () => {
  const requests: { input: string | URL | Request; init?: RequestInit }[] = [];
  const result = await prepareRemoteSession(async (input, init) => {
    requests.push({ input, init });
    return new Response('{"ok":true}', { status: 200 });
  });

  assert.equal(result, "ready");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, REMOTE_SESSION_URL);
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.body, "{}");
  assert.equal(requests[0]?.init?.credentials, "include");
});

test("falls back to browser login when session preparation is unavailable", async () => {
  assert.equal(
    await prepareRemoteSession(async () => new Response('{"ok":false}', { status: 409 })),
    "browser-login-required",
  );
  assert.equal(
    await prepareRemoteSession(async () => {
      throw new Error("offline");
    }),
    "browser-login-required",
  );
});
