import { expect, test } from "bun:test";
import { type AccountSummary, accountListSchema, poolProviders } from "../src/server/lib/pool.ts";

const NO_FAMILIES = { fable: null, sonnet: null, opus: null, haiku: null, other: null };

function account(overrides: Partial<AccountSummary>): AccountSummary {
  return {
    id: "id",
    provider: "codex",
    label: "label",
    email: null,
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority: 1,
    lastUsedAt: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    familyWeekly: NO_FAMILIES,
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  };
}

test("parses the pool's account list and ignores fields it does not read", () => {
  const raw = {
    ...account({ id: "a" }),
    kind: "oauth",
    codexAccountId: "x",
    usageRestriction: null,
    limitWindows: [
      {
        slot: "primary",
        windowMinutes: 300,
        utilization: 0.25,
        resetAt: 1,
        status: "allowed",
        observedAt: 1,
        source: "usage",
      },
    ],
  };
  expect(accountListSchema.parse([raw])[0]?.limitWindows).toEqual([
    { slot: "primary", windowMinutes: 300, utilization: 0.25, resetAt: 1 },
  ]);
});

test("Codex windows read as Session then Weekly, skipping the empty header placeholder", () => {
  const providers = poolProviders([
    account({
      email: "me@example.com",
      subscriptionType: "team",
      limitWindows: [
        { slot: "secondary", windowMinutes: 10080, utilization: 0.87, resetAt: 2000 },
        { slot: "primary", windowMinutes: 300, utilization: 0, resetAt: 1000 },
        { slot: "secondary", windowMinutes: null, utilization: 0, resetAt: 5 },
      ],
    }),
  ]);
  expect(providers).toEqual([
    {
      id: "codex",
      name: "Codex",
      accounts: [
        {
          id: "id",
          identity: "me@example.com",
          plan: "Team",
          priority: 1,
          status: "ready",
          current: true,
          observedAt: null,
          heldUntil: null,
          error: null,
          inFlight: 0,
          windows: [
            { label: "Session", usedPercent: 0, resetAt: 1000, windowMinutes: 300 },
            { label: "Weekly", usedPercent: 87, resetAt: 2000, windowMinutes: 10080 },
          ],
        },
      ],
    },
  ]);
});

test("Claude shows session, weekly, and each model's weekly window with its Max tier", () => {
  const [claude] = poolProviders([
    account({
      provider: "claude",
      label: "Scott",
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      fiveHourUtilization: 0.48,
      fiveHourResetAt: 100,
      sevenDayUtilization: 0.52,
      sevenDayResetAt: 200,
      familyWeekly: { ...NO_FAMILIES, fable: { utilization: 0.58, resetAt: 300 } },
    }),
  ]);
  expect(claude?.accounts[0]?.identity).toBe("Scott");
  expect(claude?.accounts[0]?.plan).toBe("Max 20x");
  expect(claude?.accounts[0]?.windows).toEqual([
    { label: "Session", usedPercent: 48, resetAt: 100, windowMinutes: 300 },
    { label: "Weekly", usedPercent: 52, resetAt: 200, windowMinutes: 10080 },
    { label: "Fable", usedPercent: 58, resetAt: 300, windowMinutes: 10080 },
  ]);
});

test("a Codex window of unknown length keeps its usage under its slot name", () => {
  const [codex] = poolProviders([
    account({
      limitWindows: [
        { slot: "secondary", windowMinutes: null, utilization: 0.85, resetAt: 9 },
        { slot: "primary", windowMinutes: 300, utilization: 0.1, resetAt: 1 },
      ],
    }),
  ]);
  expect(codex?.accounts[0]?.windows).toEqual([
    { label: "Session", usedPercent: 10, resetAt: 1, windowMinutes: 300 },
    { label: "Secondary", usedPercent: 85, resetAt: 9, windowMinutes: null },
  ]);
});

test("an account with requests in flight is current over a later recorded use", () => {
  const providers = poolProviders([
    account({ id: "a", priority: 1, lastUsedAt: 10, inFlight: 1 }),
    account({ id: "b", priority: 2, lastUsedAt: 90 }),
  ]);
  expect(providers[0]?.accounts.find((entry) => entry.current)?.id).toBe("a");
});

test("with nothing in flight, the most recently used enabled account is current", () => {
  const providers = poolProviders([
    account({ id: "third", priority: 3, lastUsedAt: 50 }),
    account({ id: "first", priority: 1, lastUsedAt: 10 }),
    account({ id: "second", priority: 2, lastUsedAt: 90 }),
    account({ id: "off", priority: 0, lastUsedAt: 999, enabled: false, status: "disabled" }),
  ]);
  expect(providers[0]?.accounts.map(({ id, current }) => [id, current])).toEqual([
    ["off", false],
    ["first", false],
    ["second", true],
    ["third", false],
  ]);
});

test("an unused pool marks its first enabled account current, and empty providers vanish", () => {
  const providers = poolProviders([
    account({ id: "b", priority: 2 }),
    account({ id: "a", priority: 1 }),
  ]);
  expect(providers.map((provider) => provider.id)).toEqual(["codex"]);
  expect(providers[0]?.accounts.find((entry) => entry.current)?.id).toBe("a");
});
