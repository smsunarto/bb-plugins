import { expect, test } from "bun:test";
import { builtinAccount, measurementSchema } from "../src/server/lib/builtin.ts";
import {
  type AccountExtras,
  parseClaudeExtraUsage,
  parseClaudeResetCredits,
  parseCodexBalance,
  parseResetCredits,
  purchasedCodexBalance,
} from "../src/server/lib/extras.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");

test("reset credits keep available, unexpired credits, soonest first and undated last", () => {
  const body = {
    available_count: 4,
    credits: [
      { id: "late", status: "available", expires_at: "2026-10-20T00:00:00Z" },
      { id: "forever", status: "available", expires_at: null },
      { id: "soon", status: "available", expires_at: "2026-10-03T00:00:00Z" },
      { id: "used", status: "redeemed", expires_at: "2026-10-05T00:00:00Z" },
      { id: "lapsed", status: "available", expires_at: "2026-09-30T00:00:00Z" },
    ],
  };
  expect(parseResetCredits(body, NOW)).toEqual({
    expiries: [Date.parse("2026-10-03T00:00:00Z"), Date.parse("2026-10-20T00:00:00Z"), null],
  });
});

test("no usable reset credits hides the section", () => {
  expect(parseResetCredits({ credits: [] }, NOW)).toBeNull();
  expect(parseResetCredits({ error: "nope" }, NOW)).toBeNull();
});

test("Codex balance reads numbers or numeric strings and defers to remaining_balance", () => {
  expect(
    parseCodexBalance({ credits: { has_credits: true, unlimited: false, balance: "62500" } }),
  ).toEqual({
    balance: 62500,
    ask: false,
  });
  expect(parseCodexBalance({ credits: { has_credits: true, unlimited: false } })).toEqual({
    balance: null,
    ask: true,
  });
  expect(
    parseCodexBalance({ credits: { has_credits: true, unlimited: true, balance: 5 } }),
  ).toEqual({
    balance: null,
    ask: false,
  });
  expect(parseCodexBalance({ credits: { has_credits: false } })).toEqual({
    balance: null,
    ask: false,
  });
});

test("Claude extra usage converts cents and needs an enabled cap", () => {
  expect(
    parseClaudeExtraUsage({
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, currency: "USD" },
    }),
  ).toEqual({ kind: "spend", used: 12.34, limit: 50, currency: "USD" });
  expect(
    parseClaudeExtraUsage({
      extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 1 },
    }),
  ).toBeNull();
  expect(parseClaudeExtraUsage({ extra_usage: null })).toBeNull();
});

test("Claude resets count each reset left on started, unpaused, unexpired grants", () => {
  const grant = (resets_left: number, ends_at: string | null, extra: object = {}) => ({
    id: "grant",
    resets_left,
    resets_total: 2,
    starts_at: "2026-09-01T00:00:00Z",
    ends_at,
    paused: false,
    ...extra,
  });
  const body = {
    cedar_ember: {
      eligible: true,
      grants: [
        grant(2, "2026-10-06T00:00:00Z"),
        grant(1, null),
        grant(1, "2026-10-02T00:00:00Z"),
        grant(1, "2026-10-03T00:00:00Z", { paused: true }),
        grant(0, "2026-10-03T00:00:00Z"),
        grant(1, "2026-09-30T00:00:00Z"),
        grant(1, "2026-10-09T00:00:00Z", { starts_at: "2026-10-02T00:00:00Z" }),
        { resets_left: "bad" },
      ],
    },
  };
  expect(parseClaudeResetCredits(body, NOW)).toEqual({
    expiries: [
      Date.parse("2026-10-02T00:00:00Z"),
      Date.parse("2026-10-06T00:00:00Z"),
      Date.parse("2026-10-06T00:00:00Z"),
      null,
    ],
  });
  expect(parseClaudeResetCredits({ cedar_ember: { eligible: false, grants: [] } }, NOW)).toBeNull();
  expect(parseClaudeResetCredits({ cedar_ember: { grants: [] } }, NOW)).toBeNull();
});

const resource = {
  id: "r",
  providerId: "claude-code",
  label: "Claude Code",
  scope: { kind: "shared" as const },
};

test("a built-in provider's measurement becomes a menu account with labeled windows", () => {
  const measurement = measurementSchema.parse({
    observedAt: 5,
    usage: {
      status: "ok",
      accountEmail: "me@example.com",
      planLabel: "Max 20x",
      windows: [
        {
          kind: "five-hour",
          label: "5h",
          usedPercent: 40,
          resetsAt: "2026-10-01T03:00:00Z",
          model: null,
        },
        { kind: "weekly", label: "7d", usedPercent: 52.5, resetsAt: null, model: null },
        { kind: "weekly", label: "Fable", usedPercent: 58, resetsAt: null, model: "fable" },
      ],
    },
  });
  expect(builtinAccount("k", resource, measurement, 1)).toEqual({
    id: "k",
    identity: "me@example.com",
    plan: "Max 20x",
    status: "ready",
    current: true,
    lastUsedAt: null,
    observedAt: 5,
    heldUntil: null,
    error: null,
    inFlight: 0,
    windows: [
      {
        label: "Session",
        usedPercent: 40,
        resetAt: Date.parse("2026-10-01T03:00:00Z"),
        windowMinutes: 300,
        model: null,
      },
      { label: "Weekly", usedPercent: 52.5, resetAt: null, windowMinutes: 10080, model: null },
      {
        label: "Fable weekly",
        usedPercent: 58,
        resetAt: null,
        windowMinutes: 10080,
        model: "fable",
      },
    ],
  });
});

test("a signed-out CLI shows as an error card and a missing CLI is skipped", () => {
  const signedOut = measurementSchema.parse({
    observedAt: null,
    usage: { status: "unauthenticated" },
  });
  expect(builtinAccount("k", resource, signedOut, 1)).toMatchObject({
    identity: "Claude Code",
    status: "error",
    error: "Not signed in",
  });
  const missing = measurementSchema.parse({ observedAt: null, usage: { status: "not_installed" } });
  expect(builtinAccount("k", resource, missing, 1)).toBeNull();
});

test("monthly included credit remainder is not labeled purchased extra usage", () => {
  expect(
    purchasedCodexBalance(
      { credits: { balance: 80 }, individual_limit: { limit: 100, used: 20 } },
      80,
    ),
  ).toBeNull();
  expect(
    purchasedCodexBalance(
      { rate_limit: { individual_limit: { limit: 100, remaining_percent: 80 } } },
      80,
    ),
  ).toBeNull();
  expect(purchasedCodexBalance({ individual_limit: { limit: 100, used: 20 } }, 50)).toBe(50);
  expect(
    purchasedCodexBalance({ spendControl: { individualLimit: { limit: 100, used: 20 } } }, 80),
  ).toBeNull();
  expect(purchasedCodexBalance({}, 50)).toBe(50);
});

test("provider errors never pass credential-containing parser messages into the menu", () => {
  const measurement = measurementSchema.parse({
    observedAt: null,
    usage: { status: "error", message: 'SyntaxError: {"accessToken":"fixture-secret"}' },
  });
  expect(builtinAccount("k", resource, measurement, 1)).toMatchObject({
    error: "Usage unavailable. Check the provider in bb.",
  });
});

test("blank or inconsistent Claude grant bounds never become unbounded resets", () => {
  const grant = { resets_left: 1, paused: false, ends_at: null, starts_at: null };
  expect(
    parseClaudeResetCredits(
      {
        cedar_ember: {
          eligible: true,
          grants: [
            grant,
            { ...grant, ends_at: "" },
            { ...grant, starts_at: "" },
            { ...grant, resets_total: 0 },
          ],
        },
      },
      NOW,
    ),
  ).toEqual({ expiries: [null] });
  expect(
    parseResetCredits(
      {
        credits: [
          { id: "bad", status: "available", expires_at: "" },
          { id: "good", status: "available", expires_at: null },
        ],
      },
      NOW,
    ),
  ).toEqual({ expiries: [null] });
});

test("provider extras requests obey service cancellation", async () => {
  const { claudeExtras, codexExtras } = await import("../src/server/lib/extras.ts");
  const original = globalThis.fetch;
  const controller = new AbortController();
  let captured: AbortSignal | undefined;
  globalThis.fetch = async (_url, options) => {
    captured = options?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      captured!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {
        once: true,
      });
    });
  };
  try {
    const pending = claudeExtras("fixture-token", controller.signal);
    controller.abort();
    expect(await pending).toStrictEqual({});
    expect(captured?.aborted).toBe(true);
    globalThis.fetch = async () => Response.json({ credits: { has_credits: true, balance: 7 } });
    expect(await codexExtras("fixture-token", null)).toStrictEqual({
      resetCredits: null,
      extraUsage: { kind: "balance", balance: 7 },
      resetNotice: null,
      webResetCredits: null,
    });
    expect(await codexExtras("fixture-token", null, controller.signal)).toStrictEqual({
      resetNotice: null,
      webResetCredits: null,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("a transient request leaves only the fields it reports unknown, and a revoked token clears", async () => {
  const { claudeExtras, codexExtras } = await import("../src/server/lib/extras.ts");
  const original = globalThis.fetch;
  let listed: number | undefined = 7;
  let usage = 200;
  let remaining = 200;
  let other = 429;
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith("/wham/usage"))
      return Response.json({ credits: { has_credits: true, balance: listed } }, { status: usage });
    if (pathname.endsWith("/remaining_balance"))
      return Response.json({ balance: 9 }, { status: remaining });
    return Response.json({}, { status: other });
  };
  try {
    // Reset credits throttled: the balance still arrives.
    expect(await codexExtras("fixture-token", null)).toStrictEqual({
      extraUsage: { kind: "balance", balance: 7 },
      resetNotice: null,
      webResetCredits: null,
    });
    expect(await claudeExtras("fixture-token")).toStrictEqual({});
    other = 503;
    expect(await claudeExtras("fixture-token")).toStrictEqual({});
    // Balance failing on either endpoint: the reset credits still arrive.
    other = 200;
    usage = 502;
    expect(await codexExtras("fixture-token", "workspace")).toStrictEqual({
      resetCredits: null,
      resetNotice: null,
      webResetCredits: null,
    });
    usage = 200;
    listed = undefined;
    remaining = 503;
    expect(await codexExtras("fixture-token", "workspace")).toStrictEqual({
      resetCredits: null,
      resetNotice: null,
      webResetCredits: null,
    });
    remaining = 200;
    expect(await codexExtras("fixture-token", "workspace")).toStrictEqual({
      resetCredits: null,
      extraUsage: { kind: "balance", balance: 9 },
      resetNotice: null,
      webResetCredits: null,
    });
    other = 401;
    usage = 401;
    const cleared = {
      resetCredits: null,
      extraUsage: null,
      resetNotice: null,
      webResetCredits: null,
    };
    expect(await codexExtras("fixture-token", null)).toStrictEqual(cleared);
    expect(await claudeExtras("fixture-token")).toStrictEqual(cleared);
  } finally {
    globalThis.fetch = original;
  }
});

test("a 2xx body that is not JSON is an observed none, but a cut-off read is unknown", async () => {
  const { codexExtras } = await import("../src/server/lib/extras.ts");
  const original = globalThis.fetch;
  let credits = () => new Response(null, { status: 204 });
  globalThis.fetch = async (url) =>
    String(url).endsWith("/wham/usage")
      ? Response.json({ credits: { has_credits: true, balance: 7 } })
      : credits();
  const observed: AccountExtras = {
    resetCredits: null,
    extraUsage: { kind: "balance", balance: 7 },
    resetNotice: null,
    webResetCredits: null,
  };
  try {
    expect(await codexExtras("fixture-token", null)).toStrictEqual(observed);
    credits = () =>
      new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } });
    expect(await codexExtras("fixture-token", null)).toStrictEqual(observed);
    credits = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      );
    expect(await codexExtras("fixture-token", null)).toStrictEqual({
      extraUsage: { kind: "balance", balance: 7 },
      resetNotice: null,
      webResetCredits: null,
    });
  } finally {
    globalThis.fetch = original;
  }
});
