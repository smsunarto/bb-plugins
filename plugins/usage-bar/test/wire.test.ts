import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { builtinAccount, measurementSchema } from "../src/server/lib/builtin.ts";
import { type ExtrasUpdate, NO_EXTRAS } from "../src/server/lib/extras.ts";
import { buildHelper } from "../src/server/lib/helper.ts";
import { createMenuState } from "../src/server/lib/menu-state.ts";
import { accountListSchema, type MenuSnapshot, poolProviders } from "../src/server/lib/pool.ts";
import type { Source } from "../src/server/lib/sources.ts";

const NOW = Date.parse("2026-10-01T05:00:00Z");
const NO_FAMILIES = { fable: null, sonnet: null, opus: null, haiku: null, other: null };

function summary(overrides: Record<string, unknown>) {
  return {
    id: "id",
    provider: "codex",
    label: "label",
    email: null,
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority: 0,
    lastUsedAt: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    familyWeekly: NO_FAMILIES,
    limitWindows: [],
    observedAt: NOW,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  };
}

/** Send one snapshot exactly as menu-bar.ts does and let the helper decode it. */
async function decode(snapshot: MenuSnapshot) {
  const binary = await buildHelper(AbortSignal.timeout(110_000));
  const { status, stderr } = spawnSync(binary, ["--check-snapshot"], {
    input: `${JSON.stringify({ type: "snapshot", ...snapshot })}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status, stderr };
}

test.skipIf(process.platform !== "darwin")(
  "the helper decodes a pool snapshot with every extra",
  async () => {
    const accounts = accountListSchema.parse([
      summary({
        id: "codex-held",
        email: "held@example.com",
        subscriptionType: "plus",
        priority: -5,
        lastUsedAt: NOW - 60_000,
        status: "held",
        heldUntil: NOW + 3_600_000,
        limitWindows: [
          { slot: "primary", windowMinutes: 300, utilization: 0.25, resetAt: NOW + 1_000 },
          { slot: "secondary", windowMinutes: 10080, utilization: 0.5, resetAt: NOW + 2_000 },
        ],
      }),
      summary({
        id: "codex-unknown",
        label: "Workspace",
        codexAccountId: "workspace",
        priority: 1,
        limitWindows: [{ slot: "secondary", windowMinutes: null, utilization: 0.4, resetAt: null }],
      }),
      summary({
        id: "claude-max",
        provider: "claude",
        email: "max@example.com",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        inFlight: 1,
        fiveHourUtilization: 0.48,
        fiveHourResetAt: NOW + 3_000,
        sevenDayUtilization: 0.52,
        sevenDayResetAt: NOW + 4_000,
        familyWeekly: { ...NO_FAMILIES, fable: { utilization: 0.58, resetAt: NOW + 5_000 } },
      }),
      summary({
        id: "claude-off",
        provider: "claude",
        label: "Off",
        enabled: false,
        status: "disabled",
        priority: 2,
      }),
    ]);
    const extras: Record<string, ExtrasUpdate> = {
      "codex-held": {
        resetCredits: { expiries: [NOW + 86_400_000, null] },
        extraUsage: { kind: "balance", balance: 62.5 },
      },
      "claude-max": {
        resetCredits: null,
        extraUsage: { kind: "spend", used: 12.34, limit: 50, currency: "USD" },
        resetNotice: "Check Claude for full resets",
        webResetCredits: {
          count: 2,
          expiry: "Expires Oct 22 at 9:00 AM",
          freshUntil: NOW + 600_000,
        },
      },
    };
    const source: Source = {
      kind: "pool",
      providers: poolProviders(accounts),
      extras: () => async (_provider, accountId) => extras[accountId] ?? NO_EXTRAS,
    };
    const state = createMenuState(new AbortController().signal, () => {});
    state.setSource(source);
    await state.refresh(true);
    expect(await decode(state.snapshot())).toEqual({ status: 0, stderr: "" });
  },
  120_000,
);

test.skipIf(process.platform !== "darwin")(
  "the helper decodes a built-in snapshot with an error account after a failed read",
  async () => {
    const resource = (providerId: string) => ({
      id: "local",
      providerId,
      label: providerId === "codex" ? "Codex" : "Claude Code",
      scope: { kind: "host" as const, hostId: "mac" },
    });
    const codex = builtinAccount(
      "provider-codex:local",
      resource("codex"),
      measurementSchema.parse({
        accountKey: "openai:chatgpt:workspace",
        observedAt: NOW,
        usage: {
          status: "ok",
          accountEmail: "me@example.com",
          planLabel: "Pro",
          windows: [
            {
              kind: "five-hour",
              label: "5h",
              usedPercent: 40,
              resetsAt: "2026-10-01T08:00:00Z",
              model: null,
            },
            { kind: "weekly", label: "7d", usedPercent: 52.5, resetsAt: null, model: null },
            { kind: "weekly", label: "Fable", usedPercent: 58, resetsAt: null, model: "fable" },
            { kind: "custom", label: "Monthly", usedPercent: 10, resetsAt: null, model: null },
          ],
        },
      }),
      1,
    );
    const claude = builtinAccount(
      "provider-claude:local",
      resource("claude-code"),
      measurementSchema.parse({
        observedAt: null,
        usage: { status: "error", message: "private parser output" },
      }),
      1,
    );
    const source: Source = {
      kind: "builtin",
      providers: [
        { id: "codex", name: "Codex", accounts: [codex!] },
        { id: "claude", name: "Claude", accounts: [claude!] },
      ],
      extras: () => async () => NO_EXTRAS,
    };
    const state = createMenuState(new AbortController().signal, () => {});
    state.setSource(source);
    state.failed();
    expect(await decode(state.snapshot())).toEqual({ status: 0, stderr: "" });
  },
  120_000,
);

test.skipIf(process.platform !== "darwin")(
  "the helper decodes an account whose only exhausted window is a model carve-out",
  async () => {
    const accounts = accountListSchema.parse([
      summary({
        id: "claude-carve-out",
        provider: "claude",
        email: "carve@example.com",
        subscriptionType: "max",
        fiveHourUtilization: 0.1,
        fiveHourResetAt: NOW + 1_000,
        sevenDayUtilization: 0.3,
        sevenDayResetAt: NOW + 2_000,
        familyWeekly: { ...NO_FAMILIES, opus: { utilization: 1, resetAt: NOW + 3_000 } },
      }),
    ]);
    const state = createMenuState(new AbortController().signal, () => {});
    state.setSource({
      kind: "pool",
      providers: poolProviders(accounts),
      extras: () => async () => NO_EXTRAS,
    });
    await state.refresh(true);
    const snapshot = state.snapshot();
    expect(snapshot.providers[0]?.accounts[0]?.windows).toEqual([
      { label: "Session", usedPercent: 10, resetAt: NOW + 1_000, windowMinutes: 300, model: null },
      { label: "Weekly", usedPercent: 30, resetAt: NOW + 2_000, windowMinutes: 10080, model: null },
      {
        label: "Opus weekly",
        usedPercent: 100,
        resetAt: NOW + 3_000,
        windowMinutes: 10080,
        model: "opus",
      },
    ]);
    expect(await decode(snapshot)).toEqual({ status: 0, stderr: "" });
  },
  120_000,
);
