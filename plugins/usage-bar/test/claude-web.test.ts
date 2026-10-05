import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  createClaudeWebReader,
  parseClaudeWeb,
  withClaudeWeb,
} from "../src/server/lib/claude-web.ts";
import { type AccountExtras, NO_EXTRAS } from "../src/server/lib/extras.ts";
import { createSourceReader } from "../src/server/lib/sources.ts";
import { createMenuState } from "../src/server/lib/menu-state.ts";

const NOW = Date.parse("2026-10-01T05:00:00Z");
const signal = new AbortController().signal;
function payload(email = "one@example.com", updatedAt = NOW, value = "1 available") {
  return [
    {
      provider: "claude",
      source: "web",
      usage: {
        accountEmail: email,
        identity: { accountEmail: email },
        updatedAt: new Date(updatedAt).toISOString(),
        details: [
          {
            rows: [
              {
                label: "Limit Reset Credits",
                value,
                secondaryValue: "Expires Oct 22 at 9:00 AM",
                grant_id: "never-copy",
              },
            ],
          },
        ],
        sessionKey: "never-copy",
      },
    },
  ];
}
const expected = { count: 1, expiry: "Expires Oct 22 at 9:00 AM", freshUntil: NOW + 690_000 };

test("retained quota source refreshes web resets after failure and cache expiry", async () => {
  let now = NOW;
  let calls = 0;
  let failed = false;
  const readWeb = createClaudeWebReader(
    async () => {
      calls++;
      now += 3_000;
      return payload("one@example.com", now, `${calls} available`);
    },
    () => now,
  );
  const account = {
    id: "one",
    provider: "claude",
    label: "One",
    email: "one@example.com",
    subscriptionType: "max",
    rateLimitTier: null,
    enabled: true,
    priority: 1,
    lastUsedAt: null,
    fiveHourUtilization: 0.25,
    fiveHourResetAt: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    familyWeekly: {},
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-bar",
    dataDir: "/tmp/usage-bar-refresh-no-secrets",
    sdk: {
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "account-pool" }],
        callRpc: async () => {
          if (failed) throw new Error("unavailable");
          return [account];
        },
      },
    },
  });
  try {
    const read = createSourceReader(bb, readWeb);
    const state = createMenuState(
      signal,
      () => {},
      () => now,
    );
    const shown = () => state.snapshot().providers[0]!.accounts[0]!.webResetCredits;
    await state.publish(() => read(signal, false));
    await state.refresh();
    expect(shown()).toEqual({ ...expected, freshUntil: NOW + 693_000 });
    failed = true;
    now += 301_000;
    await state.publish(() => read(signal, true), true);
    expect(shown()).toEqual({ ...expected, count: 2, freshUntil: now + 690_000 });
    expect(state.snapshot().error).toBe("Couldn't refresh usage. Showing the last reading.");
    const started = now;
    await state.publish(() => read(signal, true), true);
    expect(shown()).toEqual({ ...expected, count: 3, freshUntil: now + 690_000 });
    // The service gate must not reopen before the reader's completed-read cache expires.
    now = started + 301_000;
    await state.publish(() => read(signal, false));
    await state.refresh();
    expect(shown()).toEqual({ ...expected, count: 3, freshUntil: started + 693_000 });
    now = started + 303_001;
    await state.publish(() => read(signal, false));
    await state.refresh();
    expect(shown()).toEqual({ ...expected, count: 4, freshUntil: now + 690_000 });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("reads display-safe web resets and rejects stale or ambiguous output", () => {
  expect(parseClaudeWeb(payload(" ONE@example.com "), NOW)).toEqual({
    email: "one@example.com",
    credits: expected,
  });
  expect(parseClaudeWeb(payload("one@example.com", NOW - 300_000), NOW)).toBeNull();
  expect(parseClaudeWeb(payload("one@example.com", NOW + 31_000), NOW)).toBeNull();
  expect(parseClaudeWeb(payload("one@example.com", NOW, "51 available"), NOW)).toBeNull();
  expect(parseClaudeWeb(payload("one@example.com", NOW, "0 available"), NOW)).toBeNull();
  expect(parseClaudeWeb([...payload(), ...payload()], NOW)).toBeNull();
  const mismatch = payload();
  mismatch[0]!.usage.identity.accountEmail = "two@example.com";
  expect(parseClaudeWeb(mismatch, NOW)).toBeNull();
  const wrongSource = payload();
  wrongSource[0]!.source = "oauth";
  expect(parseClaudeWeb(wrongSource, NOW)).toBeNull();
  const secrets = JSON.stringify(parseClaudeWeb(payload(), NOW));
  expect(secrets).not.toContain("never-copy");
});

test("web resets attach only to one matching account and never add to OAuth inventory", () => {
  const web = parseClaudeWeb(payload(), NOW);
  const accounts = [
    { id: "one", email: "ONE@example.com" },
    { id: "two", email: "two@example.com" },
  ];
  expect(withClaudeWeb(NO_EXTRAS, "one", accounts, web)).toEqual({
    ...NO_EXTRAS,
    webResetCredits: expected,
    resetNotice: "Check Claude for full resets",
  });
  expect(withClaudeWeb(NO_EXTRAS, "two", accounts, web)).toEqual(NO_EXTRAS);
  expect(
    withClaudeWeb(
      NO_EXTRAS,
      "one",
      [...accounts, { id: "disabled", email: "one@example.com" }],
      web,
    ),
  ).toEqual(NO_EXTRAS);
  const oauth = { resetCredits: { expiries: [null] }, extraUsage: null };
  expect(withClaudeWeb(oauth, "one", accounts, web)).toEqual(oauth);
});

test("shares requests, caches failures, and Refresh bypasses the web cache", async () => {
  let calls = 0;
  let now = NOW;
  const read = createClaudeWebReader(
    async () => {
      calls++;
      return payload("one@example.com", now);
    },
    () => now,
  );
  expect(await Promise.all([read(signal, true), read(signal, true)])).toEqual([
    { email: "one@example.com", credits: expected },
    { email: "one@example.com", credits: expected },
  ]);
  await read(signal, false);
  expect(calls).toBe(1);
  await read(signal, true);
  expect(calls).toBe(2);
  now += 300_000;
  expect(await read(signal, false)).toEqual({
    email: "one@example.com",
    credits: { ...expected, freshUntil: now + 690_000 },
  });
  expect(calls).toBe(3);
  let failures = 0;
  const failed = createClaudeWebReader(
    async () => {
      failures++;
      throw new Error("private stderr");
    },
    () => now,
  );
  expect(await failed(signal, false)).toBeNull();
  expect(await failed(signal, false)).toBeNull();
  expect(failures).toBe(1);
  expect(await failed(signal, true)).toBeNull();
  expect(failures).toBe(2);
});

test("a reading accepted near the parse limit stays fresh natively past the next refresh", async () => {
  // FRESH_MS - 1_000 old: the oldest reading the parse gate accepts.
  const updatedAt = NOW - 299_000;
  let now = NOW;
  const read = createClaudeWebReader(
    async () => payload("one@example.com", updatedAt),
    () => now,
  );
  const freshUntil = (await read(signal, false))?.credits.freshUntil ?? 0;
  expect(freshUntil).toBe(updatedAt + 690_000);
  expect(freshUntil - now).toBeGreaterThanOrEqual(300_000 + 60_000);
  // The cache keeps serving it, but a re-fetch after one cycle is too old to parse.
  now += 10_000;
  expect((await read(signal, false))?.credits.freshUntil).toBe(freshUntil);
  now = NOW + 300_000;
  expect(await read(signal, false)).toBeNull();
});

test("while Claude OAuth is throttled, web resets keep refreshing over the kept extras", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "usage-bar-throttled-"));
  const secrets = join(dataDir, "plugins/account-pool/secrets/accounts");
  await mkdir(secrets, { recursive: true });
  await writeFile(
    join(secrets, "account-one.json"),
    JSON.stringify({ kind: "oauth", accessToken: "fixture-token", expiresAt: null }),
  );
  let status = 200;
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000 } },
      { status },
    );
  let now = NOW;
  let calls = 0;
  const readWeb = createClaudeWebReader(
    async () => {
      calls++;
      return payload("one@example.com", now, `${calls} available`);
    },
    () => now,
  );
  const account = {
    id: "one",
    provider: "claude",
    label: "One",
    email: "one@example.com",
    subscriptionType: "max",
    rateLimitTier: null,
    enabled: true,
    priority: 1,
    lastUsedAt: null,
    fiveHourUtilization: 0.25,
    fiveHourResetAt: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    familyWeekly: {},
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-bar",
    dataDir,
    sdk: {
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "account-pool" }],
        callRpc: async () => [account],
      },
    },
  });
  try {
    const state = createMenuState(
      signal,
      () => {},
      () => now,
    );
    state.setSource(await createSourceReader(bb, readWeb)(signal, false));
    const shown = () => {
      const { resetCredits, extraUsage, resetNotice, webResetCredits } =
        state.snapshot().providers[0]!.accounts[0]!;
      return { resetCredits, extraUsage, resetNotice, webResetCredits };
    };
    const observed = (count: number, at: number): AccountExtras => ({
      resetCredits: null,
      extraUsage: { kind: "spend", used: 10, limit: 50, currency: "USD" },
      resetNotice: "Check Claude for full resets",
      webResetCredits: { ...expected, count, freshUntil: at + 690_000 },
    });
    await state.refresh(true);
    expect(shown()).toEqual(observed(1, NOW));
    status = 429;
    now += 60_000;
    await state.refresh(true);
    expect(shown()).toEqual(observed(2, NOW + 60_000));
    now += 60_000;
    await state.refresh(true);
    expect(shown()).toEqual(observed(3, NOW + 120_000));
    expect(calls).toBe(3);
  } finally {
    globalThis.fetch = original;
    await harness.lifecycle.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pool source shares one web refresh and keeps a mismatched pooled account empty", async () => {
  let calls = 0;
  const readWeb = createClaudeWebReader(
    async () => {
      calls++;
      return payload();
    },
    () => NOW,
  );
  const accounts = ["one", "two"].map((id, index) => ({
    id,
    provider: "claude",
    label: id,
    email: `${id}@example.com`,
    subscriptionType: "max",
    rateLimitTier: null,
    enabled: true,
    priority: index + 1,
    lastUsedAt: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    familyWeekly: {},
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
  }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-bar",
    dataDir: "/tmp/usage-bar-no-secrets",
    sdk: {
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "account-pool" }],
        callRpc: async () => accounts,
      },
    },
  });
  try {
    const read = createSourceReader(bb, readWeb);
    const source = await read(signal, false);
    const batch = source.extras(true);
    expect(await Promise.all([batch("claude", "one"), batch("claude", "two")])).toEqual([
      { ...NO_EXTRAS, webResetCredits: expected, resetNotice: "Check Claude for full resets" },
      NO_EXTRAS,
    ]);
    expect(calls).toBe(1);
    // A slower account can reach the fallback after the shared read settles.
    expect(await batch("claude", "two")).toEqual(NO_EXTRAS);
    expect(calls).toBe(1);
    const next = await read(signal, false);
    await next.extras()("claude", "one");
    expect(calls).toBe(1);
    const refreshed = await read(signal, true);
    await refreshed.extras(true)("claude", "one");
    expect(calls).toBe(2);
    accounts[1]!.email = "one@example.com";
    const duplicate = await read(signal, false);
    expect(await duplicate.extras(true)("claude", "one")).toEqual(NO_EXTRAS);
    expect(calls).toBe(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});
