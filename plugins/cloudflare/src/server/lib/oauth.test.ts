import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CloudflareOAuth,
  OAUTH_CALLBACK_PATH,
  oauthCallbackResponse,
  type OAuthSettings,
} from "./oauth.ts";

const accountId = "a".repeat(32);
const redirectUri = `https://bb.example.com${OAUTH_CALLBACK_PATH}`;
const tokenResponse = (suffix = "one", expires = 3600) =>
  Response.json({
    access_token: `ACCESS-SECRET-${suffix}`,
    refresh_token: `REFRESH-SECRET-${suffix}`,
    token_type: "bearer",
    expires_in: expires,
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function fixture() {
  let now = Date.UTC(2026, 8, 5);
  const settings: OAuthSettings = {
    oauthClientId: "client",
    oauthRedirectUri: redirectUri,
    accountId,
    oauthScopes: "zone.read dns.write",
  };
  const save = mock(async (value: string | null) => {
    settings.oauthCredentials = value ?? undefined;
  });
  const fetcher = mock<typeof fetch>(async () => tokenResponse());
  const auth = new CloudflareOAuth({
    settings: async () => ({ ...settings }),
    save,
    fetcher,
    now: () => now,
  });
  const begin = async () => new URL((await auth.connect()).authorizationUrl);
  const callback = (url: URL, code = "CODE-SECRET") =>
    new URLSearchParams({ state: url.searchParams.get("state")!, code });
  return {
    auth,
    settings,
    save,
    fetcher,
    begin,
    callback,
    now: () => now,
    advance: (duration: number) => {
      now += duration;
    },
  };
}
async function login(f: ReturnType<typeof fixture>, expires = 3600) {
  f.fetcher.mockImplementation(async () => tokenResponse("one", expires));
  const url = await f.begin();
  await f.auth.callback(f.callback(url));
  return url;
}

test("connect issues unique expiring state and S256 PKCE without exposing the verifier", async () => {
  const f = fixture();
  const url = await f.begin();
  const other = await f.begin();
  expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
  expect(url.searchParams.get("scope")).toBe("dns.write offline_access zone.read");
  expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).not.toBe(other.searchParams.get("state"));
  expect(url.searchParams.get("code_verifier")).toBeNull();
  expect(f.save).not.toHaveBeenCalled();
  await f.auth.callback(f.callback(url));
  const [endpoint, request] = f.fetcher.mock.calls[0]!;
  expect(endpoint).toBe("https://dash.cloudflare.com/oauth2/token");
  expect(request?.redirect).toBe("error");
  const body = new URLSearchParams(String(request?.body));
  expect(body.get("client_secret")).toBeNull();
  expect(body.get("redirect_uri")).toBe(redirectUri);
  expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
    url.searchParams.get("code_challenge")!,
  );
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(await f.auth.credentials()).toEqual({
    token: "ACCESS-SECRET-one",
    accountId,
    clientId: "client",
  });
  expect(JSON.stringify(await f.auth.status())).not.toContain("SECRET");
});

test("callback rejects missing, duplicate, unknown and replayed state without exchanging credentials", async () => {
  const f = fixture();
  await expect(f.auth.callback(new URLSearchParams({ code: "secret" }))).rejects.toThrow("expired");
  await expect(
    f.auth.callback(new URLSearchParams({ state: "unknown", code: "secret" })),
  ).rejects.toThrow("expired");
  const url = await f.begin();
  const duplicate = f.callback(url);
  duplicate.append("state", url.searchParams.get("state")!);
  await expect(f.auth.callback(duplicate)).rejects.toThrow("expired");
  expect(f.fetcher).not.toHaveBeenCalled();
  const params = f.callback(url);
  const first = f.auth.callback(params);
  await expect(f.auth.callback(params)).rejects.toThrow("already");
  await first;
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test("denied, malformed and expired callbacks consume state and never log provider messages", async () => {
  for (const kind of ["denied", "missing-code", "duplicate-code", "expired"]) {
    const f = fixture();
    const url = await f.begin();
    const params = f.callback(url);
    if (kind === "denied") {
      params.set("error", "access_denied");
      params.set("error_description", "SECRET");
    }
    if (kind === "missing-code") params.delete("code");
    if (kind === "duplicate-code") params.append("code", "another");
    if (kind === "expired") f.advance(10 * 60 * 1000);
    let message = "";
    try {
      await f.auth.callback(params);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("SECRET");
    await expect(f.auth.callback(params)).rejects.toThrow("expired");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  }
});

test("callback expiry is rechecked after waiting for serialized refresh", async () => {
  const f = fixture();
  await login(f, 1);
  const url = await f.begin();
  const entered = deferred<void>();
  const response = deferred<Response>();
  f.fetcher.mockImplementation(async () => {
    entered.resolve();
    return response.promise;
  });
  const refresh = f.auth.credentials();
  await entered.promise;
  const callback = f.auth.callback(f.callback(url));
  const assertion = callback.catch((error: Error) => error);
  f.advance(10 * 60 * 1000);
  response.resolve(tokenResponse("two"));
  await refresh;
  expect(await assertion).toBeInstanceOf(Error);
  expect(String(await assertion)).toContain("expired");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

for (const [key, value] of [
  ["oauthClientId", "other-client"],
  ["oauthRedirectUri", `https://other.example.com${OAUTH_CALLBACK_PATH}`],
  ["accountId", "b".repeat(32)],
  ["oauthScopes", "zone.read"],
] as const) {
  test(`${key} binds both pending login and saved authorization`, async () => {
    const f = fixture();
    const url = await f.begin();
    const original = f.settings[key];
    f.settings[key] = value;
    await expect(f.auth.callback(f.callback(url))).rejects.toThrow("changed");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.settings[key] = original;
    await login(f);
    f.settings[key] = value;
    expect((await f.auth.status()).connected).toBe(false);
    await expect(f.auth.credentials()).rejects.toThrow("Connect");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
}

test("only exact HTTPS callback configurations can start authorization", async () => {
  for (const value of [
    `http://bb.example.com${OAUTH_CALLBACK_PATH}`,
    `https://bb.example.com${OAUTH_CALLBACK_PATH}?next=evil`,
    `https://bb.example.com${OAUTH_CALLBACK_PATH}#evil`,
    `https://user:secret@bb.example.com${OAUTH_CALLBACK_PATH}`,
    "https://bb.example.com/other-callback",
  ]) {
    const f = fixture();
    f.settings.oauthRedirectUri = value;
    expect((await f.auth.status()).configured).toBe(false);
    await expect(f.begin()).rejects.toThrow("exact HTTPS");
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});

test("concurrent callers refresh once and persist rotated secrets together", async () => {
  const f = fixture();
  await login(f, 1);
  f.fetcher.mockImplementation(async () => tokenResponse("two"));
  const answers = await Promise.all(Array.from({ length: 12 }, () => f.auth.credentials()));
  expect(answers.every((answer) => answer.token === "ACCESS-SECRET-two")).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.save).toHaveBeenCalledTimes(2);
  const saved = JSON.parse(f.settings.oauthCredentials!);
  expect(saved.accessToken).toBe("ACCESS-SECRET-two");
  expect(saved.refreshToken).toBe("REFRESH-SECRET-two");
  const body = new URLSearchParams(String(f.fetcher.mock.calls[1]![1]?.body));
  expect(body.get("refresh_token")).toBe("REFRESH-SECRET-one");
});

test("invalid refresh grants clear saved authorization and sanitize provider errors", async () => {
  const f = fixture();
  await login(f, 1);
  f.fetcher.mockImplementation(async () =>
    Response.json(
      { error: "invalid_grant", error_description: "REFRESH-SECRET-one" },
      { status: 400 },
    ),
  );
  await expect(f.auth.credentials()).rejects.toThrow("Connect Cloudflare again");
  expect(f.settings.oauthCredentials).toBeUndefined();
  expect((await f.auth.status()).connected).toBe(false);
  await expect(f.auth.credentials()).rejects.toThrow("Connect Cloudflare again");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

test("transient refresh failure keeps existing authorization and redacts network details", async () => {
  const f = fixture();
  await login(f, 1);
  const saved = f.settings.oauthCredentials;
  f.fetcher.mockImplementation(async () => {
    throw new Error("REFRESH-SECRET-one");
  });
  await expect(f.auth.credentials()).rejects.toThrow("could not be reached");
  expect(f.settings.oauthCredentials).toBe(saved);
});

test("disconnect cancels pending login and prevents an in-flight refresh from restoring credentials", async () => {
  const f = fixture();
  await login(f, 1);
  const url = await f.begin();
  const entered = deferred<void>();
  const response = deferred<Response>();
  f.fetcher.mockImplementation(async (endpoint) => {
    if (String(endpoint).endsWith("/revoke")) return new Response(null, { status: 200 });
    entered.resolve();
    return response.promise;
  });
  const refresh = f.auth.credentials();
  const rejected = refresh.catch((error: Error) => error);
  await entered.promise;
  const disconnect = f.auth.disconnect();
  response.resolve(tokenResponse("two"));
  expect(String(await rejected)).toContain("changed");
  expect((await disconnect).ok).toBe(true);
  expect(f.settings.oauthCredentials).toBeUndefined();
  expect(
    f.save.mock.calls.map(([value]) => (value === null ? null : JSON.parse(value).accessToken)),
  ).toEqual(["ACCESS-SECRET-one", null]);
  await expect(f.auth.callback(f.callback(url))).rejects.toThrow("expired");
  const revoked = f.fetcher.mock.calls.filter(([endpoint]) => String(endpoint).endsWith("/revoke"));
  expect(revoked).toHaveLength(2);
  expect(new URLSearchParams(String(revoked[0]![1]?.body)).get("token")).toBe("REFRESH-SECRET-two");
});

test("reload waits for refresh settlement and never persists its late result", async () => {
  const f = fixture();
  await login(f, 1);
  const entered = deferred<void>();
  const response = deferred<Response>();
  f.fetcher.mockImplementation(async (endpoint) => {
    if (String(endpoint).endsWith("/revoke")) return new Response(null, { status: 200 });
    entered.resolve();
    return response.promise;
  });
  const refresh = f.auth.credentials();
  const rejected = refresh.catch((error: Error) => error);
  await entered.promise;
  const disposed = f.auth.dispose();
  response.resolve(tokenResponse("two"));
  expect(String(await rejected)).toContain("changed");
  await disposed;
  expect(f.save).toHaveBeenCalledTimes(1);
  await expect(f.auth.connect()).rejects.toThrow("reloading");
  await expect(f.auth.credentials()).rejects.toThrow("reloading");
});

test("changed settings during exchange prevent saving credentials for stale configuration", async () => {
  const f = fixture();
  const url = await f.begin();
  const entered = deferred<void>();
  const response = deferred<Response>();
  f.fetcher.mockImplementation(async (endpoint) => {
    if (String(endpoint).endsWith("/revoke")) return new Response(null, { status: 200 });
    entered.resolve();
    return response.promise;
  });
  const callback = f.auth.callback(f.callback(url));
  const rejected = callback.catch((error: Error) => error);
  await entered.promise;
  f.settings.accountId = "b".repeat(32);
  response.resolve(tokenResponse());
  expect(String(await rejected)).toContain("changed");
  expect(f.save).not.toHaveBeenCalled();
});

test("disconnect clears local credentials even when revocation is unavailable", async () => {
  const f = fixture();
  await login(f);
  f.fetcher.mockImplementation(async () => {
    throw new Error("SECRET");
  });
  const result = await f.auth.disconnect();
  expect(result.message).toContain("could not be confirmed");
  expect(result.message).not.toContain("SECRET");
  expect(f.settings.oauthCredentials).toBeUndefined();
});

test("callback responses return to the plugin with no provider details or caching", async () => {
  const success = oauthCallbackResponse(true);
  expect(success.status).toBe(303);
  expect(success.headers.get("location")).toBe("/plugins/cloudflare/cloudflare");
  for (const response of [success, oauthCallbackResponse(false)]) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  const denied = oauthCallbackResponse(false);
  expect(denied.status).toBe(400);
  expect(await denied.text()).toContain('href="/plugins/cloudflare/cloudflare"');
});

test("OAuth scope configuration is required, bounded, and deduplicated", async () => {
  for (const value of [
    undefined,
    "",
    "offline_access",
    "a".repeat(129),
    Array.from({ length: 65 }, (_, index) => `scope${index}`).join(" "),
    " ".repeat(8193),
  ]) {
    const f = fixture();
    f.settings.oauthScopes = value;
    expect((await f.auth.status()).configured).toBe(false);
    await expect(f.begin()).rejects.toThrow("OAuth permissions");
  }
  const f = fixture();
  f.settings.oauthScopes = "zone.read dns.write zone.read offline_access";
  const url = await f.begin();
  expect(url.searchParams.get("scope")).toBe("dns.write offline_access zone.read");
  await f.auth.callback(f.callback(url));
  f.settings.oauthScopes = "dns.write zone.read";
  expect((await f.auth.status()).connected).toBe(true);
});

test("registered scopes remain opaque while invalid OAuth scope-token characters are rejected", async () => {
  const f = fixture();
  f.settings.oauthScopes = "registered_resource:Read/one?x=ok opaque_123";
  const url = await f.begin();
  expect(url.searchParams.get("scope")).toBe(
    "offline_access opaque_123 registered_resource:Read/one?x=ok",
  );
  await f.auth.callback(f.callback(url));
  expect((await f.auth.status()).connected).toBe(true);
  for (const value of [
    'scope"quote',
    "scope\\backslash",
    "scope\u0000",
    "scope\u007f",
    "résource.read",
  ]) {
    const invalid = fixture();
    invalid.settings.oauthScopes = value;
    expect((await invalid.auth.status()).configured).toBe(false);
    await expect(invalid.begin()).rejects.toThrow("OAuth permissions");
  }
});

test("provider responses must grant every requested scope when a scope list is returned", async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (endpoint) =>
    String(endpoint).endsWith("/revoke")
      ? new Response(null, { status: 200 })
      : Response.json({
          access_token: "SECRET",
          refresh_token: "SECRET",
          token_type: "bearer",
          expires_in: 3600,
          scope: "zone.read offline_access",
        }),
  );
  const url = await f.begin();
  await expect(f.auth.callback(f.callback(url))).rejects.toThrow("Connect Cloudflare again");
  expect(f.save).not.toHaveBeenCalled();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

test("completing one login invalidates a second callback already queued for exchange", async () => {
  const f = fixture();
  const first = await f.begin();
  const second = await f.begin();
  const entered = deferred<void>();
  const response = deferred<Response>();
  f.fetcher.mockImplementation(async () => {
    entered.resolve();
    return response.promise;
  });
  const firstCallback = f.auth.callback(f.callback(first));
  await entered.promise;
  const secondCallback = f.auth.callback(f.callback(second)).catch((error: Error) => error);
  response.resolve(tokenResponse());
  await firstCallback;
  expect(String(await secondCallback)).toContain("changed");
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test("failed credential persistence revokes the new grant without leaking storage errors", async () => {
  const f = fixture();
  f.save.mockImplementation(async () => {
    throw new Error("SECRET storage failure");
  });
  const url = await f.begin();
  await expect(f.auth.callback(f.callback(url))).rejects.toThrow("could not be saved");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(String(f.fetcher.mock.calls[1]![0])).toBe("https://dash.cloudflare.com/oauth2/revoke");
});
