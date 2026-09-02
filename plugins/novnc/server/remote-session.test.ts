import { test } from "bun:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  cookieDomainCoversHost,
  createRemoteSessionResponse,
  serializeRemoteSessionCookie,
} from "./remote-session.ts";

const expiresAt = Date.UTC(2026, 7, 31, 22, 30, 0);
const cookie = {
  domain: ".getbb.app",
  expiresAt,
  name: "__Secure-bb-connect.desktop_session",
  value: "payload.signature",
};

function fakeBb(result: unknown | Error): BbPluginApi {
  return {
    sdk: {
      plugins: {
        callRpc: async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      },
    },
  } as never;
}

test("recognizes exact and subdomain cookie coverage", () => {
  assert.equal(cookieDomainCoversHost(".getbb.app", "getbb.app"), true);
  assert.equal(cookieDomainCoversHost(".getbb.app", "scott.getbb.app"), true);
  assert.equal(cookieDomainCoversHost(".getbb.app", "notgetbb.app"), false);
});

test("serializes a secure one-hour browser session cookie", () => {
  assert.equal(
    serializeRemoteSessionCookie(cookie, expiresAt - 3_600_000),
    "__Secure-bb-connect.desktop_session=payload.signature; Domain=.getbb.app; Path=/; Max-Age=3600; Expires=Mon, 31 Aug 2026 22:30:00 GMT; Secure; HttpOnly; SameSite=Lax",
  );
});

test("mints and installs a connect session for a remote bb origin", async () => {
  const response = await createRemoteSessionResponse(fakeBb({ cookie }), {
    host: "scott.getbb.app",
    requestUrl: "https://scott.getbb.app/api/v1/plugins/novnc/http/remote-session",
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /^__Secure-bb-connect\.desktop_session=/u);
  assert.deepEqual(await response.json(), { ok: true, expiresAt });
});

test("uses the connect session marker when the tunnel rewrites the host", async () => {
  const request = {
    gateAuth: "session",
    host: "127.0.0.1:38886",
    requestUrl: "http://127.0.0.1:38886/api/v1/plugins/novnc/http/remote-session",
  };
  const response = await createRemoteSessionResponse(fakeBb({ cookie }), request);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /^__Secure-bb-connect\.desktop_session=/u);
  assert.deepEqual(await response.json(), { ok: true, expiresAt });
});

test("uses top-level login when the response origin cannot set the gate cookie", async () => {
  const response = await createRemoteSessionResponse(fakeBb({ cookie }), {
    host: "127.0.0.1:38886",
    requestUrl: "http://127.0.0.1:38886/api/v1/plugins/novnc/http/remote-session",
  });

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { ok: false, reason: "browser-login-required" });
});

test("uses top-level login when connect cannot mint a session", async () => {
  const response = await createRemoteSessionResponse(fakeBb(new Error("not paired")), {
    host: "scott.getbb.app",
    requestUrl: "https://scott.getbb.app/api/v1/plugins/novnc/http/remote-session",
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, reason: "browser-login-required" });
});
