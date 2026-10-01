import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  createClaudeWebReader,
  parseClaudeWeb,
  withClaudeWeb,
} from "../src/server/lib/claude-web.ts";
import { NO_EXTRAS } from "../src/server/lib/extras.ts";
import { createSourceReader } from "../src/server/lib/sources.ts";

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
const expected = { count: 1, expiry: "Expires Oct 22 at 9:00 AM", freshUntil: NOW + 300_000 };

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
    credits: { ...expected, freshUntil: now + 300_000 },
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

test("a cached observation expires independently of the request cache", async () => {
  let now = NOW;
  const read = createClaudeWebReader(
    async () => payload("one@example.com", NOW - 290_000),
    () => now,
  );
  expect((await read(signal, false))?.credits.freshUntil).toBe(NOW + 10_000);
  now += 10_000;
  expect(await read(signal, false)).toBeNull();
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
    pluginId: "pool-bar",
    dataDir: "/tmp/pool-bar-no-secrets",
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
    expect(
      await Promise.all([
        source.extras("claude", "one", true),
        source.extras("claude", "two", true),
      ]),
    ).toEqual([
      { ...NO_EXTRAS, webResetCredits: expected, resetNotice: "Check Claude for full resets" },
      NO_EXTRAS,
    ]);
    expect(calls).toBe(1);
    const next = await read(signal, false);
    await next.extras("claude", "one");
    expect(calls).toBe(1);
    const refreshed = await read(signal, true);
    await refreshed.extras("claude", "one", true);
    expect(calls).toBe(2);
    accounts[1]!.email = "one@example.com";
    const duplicate = await read(signal, false);
    expect(await duplicate.extras("claude", "one", true)).toEqual(NO_EXTRAS);
    expect(calls).toBe(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});
