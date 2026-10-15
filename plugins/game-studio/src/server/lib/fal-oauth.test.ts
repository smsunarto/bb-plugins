import { expect, test } from "bun:test";
import { FalOAuth } from "./fal-oauth.ts";

function fixture() {
  let saved: string | undefined,
    now = 1000;
  const requests: { path: string; body: URLSearchParams; authorization: string | null }[] = [];
  let tokenPolls = 0,
    refreshes = 0;
  const fetcher = (async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = new URLSearchParams(String(options?.body ?? ""));
    requests.push({
      path,
      body,
      authorization: new Headers(options?.headers).get("Authorization"),
    });
    if (path === "/oauth/device/code")
      return Response.json({
        device_code: "private-device-code",
        user_code: "USER-CODE",
        verification_uri_complete: "https://auth.fal.ai/activate?user_code=USER-CODE",
        expires_in: 600,
        interval: 5,
      });
    if (path === "/userinfo") return Response.json({ sub: "user-id", email: "scott@example.com" });
    if (path === "/oauth/revoke") return new Response(null, { status: 200 });
    if (body.get("grant_type") === "refresh_token") {
      refreshes++;
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    tokenPolls++;
    return tokenPolls === 1
      ? Response.json({ error: "authorization_pending" }, { status: 403 })
      : Response.json({
          access_token: "original-access",
          refresh_token: "original-refresh",
          token_type: "Bearer",
          expires_in: 120,
        });
  }) as typeof fetch;
  const create = () =>
    new FalOAuth({
      read: async () => saved,
      save: async (value) => {
        saved = value ?? undefined;
      },
      now: () => now,
      fetcher,
    });
  return {
    create,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
    saved: () => saved,
    refreshes: () => refreshes,
  };
}

test("device login exposes only the browser code, saves the approved account privately and survives restart", async () => {
  const f = fixture(),
    auth = f.create();
  expect(await auth.execute("status")).toEqual({ state: "disconnected" });
  const connected = await auth.execute("connect");
  expect(connected).toEqual({
    state: "pending",
    authorizationUrl: "https://auth.fal.ai/activate?user_code=USER-CODE",
    userCode: "USER-CODE",
    expiresAt: 601000,
    nextPollAt: 6000,
  });
  expect(JSON.stringify(connected)).not.toContain("private-device-code");
  expect(await auth.execute("poll")).toEqual(connected);
  f.advance(5000);
  expect((await auth.execute("poll")).state).toBe("pending");
  f.advance(5000);
  const status = await auth.execute("poll");
  expect(status).toEqual({ state: "connected", account: "scott@example.com", expiresAt: 131000 });
  expect(JSON.stringify(status)).not.toContain("original-access");
  expect(f.requests.find((request) => request.path === "/userinfo")?.authorization).toBe(
    "Bearer original-access",
  );
  expect(f.saved()).toContain("original-refresh");
  await auth.dispose();
  expect(await f.create().execute("status")).toEqual(status);
});

test("concurrent work refreshes once, persists rotation before use, and disconnect revokes the current grant", async () => {
  const f = fixture(),
    auth = f.create();
  await auth.execute("connect");
  f.advance(5000);
  await auth.execute("poll");
  f.advance(5000);
  await auth.execute("poll");
  f.advance(61000);
  expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual([
    "refreshed-access",
    "refreshed-access",
  ]);
  expect(f.refreshes()).toBe(1);
  expect(JSON.parse(f.saved()!).refreshToken).toBe("rotated-refresh");
  expect(await auth.execute("disconnect")).toEqual({ state: "disconnected" });
  expect(f.requests.find((request) => request.path === "/oauth/revoke")?.body.get("token")).toBe(
    "rotated-refresh",
  );
  await expect(auth.accessToken()).rejects.toThrow("Connect Fal");
});

test("expired or declined device authorization never persists tokens or returns provider error details", async () => {
  let saved: string | null = null;
  const auth = new FalOAuth({
    read: async () => saved ?? undefined,
    save: async (value) => {
      saved = value;
    },
    fetcher: (async () =>
      Response.json(
        { error: "access_denied", error_description: "private-server-detail" },
        { status: 403 },
      )) as typeof fetch,
  });
  await expect(auth.execute("connect")).rejects.toThrow("could not start browser sign-in");
  expect(await auth.execute("status")).toEqual({ state: "disconnected" });
  const f = fixture(),
    expires = f.create();
  await expires.execute("connect");
  f.advance(601000);
  await expect(expires.execute("poll")).rejects.toThrow("expired");
  expect(await expires.execute("status")).toEqual({ state: "disconnected" });
});

test("a reload waits for refresh rotation to be saved before the worker exits", async () => {
  let saved = JSON.stringify({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 121000,
    account: "scott@example.com",
  });
  let started!: () => void, finish!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const auth = new FalOAuth({
    read: async () => saved,
    save: async (value) => {
      saved = value!;
    },
    now: () => 1000,
    fetcher: (async () => {
      started();
      await gate;
      return Response.json({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as typeof fetch,
  });
  const token = auth.accessToken();
  await refreshing;
  const disposed = auth.dispose();
  finish();
  expect(await token).toBe("fresh-access");
  await disposed;
  expect(JSON.parse(saved).refreshToken).toBe("fresh-refresh");
  const restarted = new FalOAuth({
    read: async () => saved,
    save: async () => {},
    now: () => 1000,
  });
  expect(await restarted.accessToken()).toBe("fresh-access");
});

test("transient refresh failures preserve the session but revoked grants disconnect", async () => {
  let saved: string | undefined = JSON.stringify({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1000,
    account: "scott@example.com",
  });
  let unavailable = true;
  const auth = new FalOAuth({
    read: async () => saved,
    save: async (value) => {
      saved = value ?? undefined;
    },
    now: () => 1000,
    fetcher: (async () =>
      unavailable
        ? Response.json({ error: "temporarily_unavailable" }, { status: 503 })
        : Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch,
  });
  await expect(auth.accessToken()).rejects.toThrow("Retry when Fal is available");
  expect((await auth.execute("status")).state).toBe("connected");
  unavailable = false;
  await expect(auth.accessToken()).rejects.toThrow("Connect Fal again");
  expect(await auth.execute("status")).toEqual({ state: "disconnected" });
});
