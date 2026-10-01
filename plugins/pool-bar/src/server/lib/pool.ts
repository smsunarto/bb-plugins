import { z } from "zod";
import type { ExtraUsage, ResetCredits } from "./extras.ts";
import type { WebResetCredits } from "./claude-web.ts";

/**
 * The slice of Account Pooler's `AccountSummary` (bb `plugins/account-pool/src/contracts.ts`)
 * this plugin reads. Unknown fields are stripped, so new pool fields never break the parse.
 * `utilization` is a 0..1 fraction; every timestamp is epoch milliseconds.
 */
const quotaSchema = z.object({
  utilization: z.number().nullable(),
  resetAt: z.number().nullable(),
});

const accountSummarySchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  codexAccountId: z.string().optional(),
  subscriptionType: z.string().nullable(),
  rateLimitTier: z.string().nullable(),
  enabled: z.boolean(),
  priority: z.number(),
  lastUsedAt: z.number().nullable(),
  fiveHourUtilization: z.number().nullable(),
  fiveHourResetAt: z.number().nullable(),
  sevenDayUtilization: z.number().nullable(),
  sevenDayResetAt: z.number().nullable(),
  familyWeekly: z.record(z.string(), quotaSchema.nullable()),
  limitWindows: z.array(
    quotaSchema.extend({ slot: z.string(), windowMinutes: z.number().nullable() }),
  ),
  observedAt: z.number().nullable(),
  heldUntil: z.number().nullable(),
  error: z.string().nullable(),
  inFlight: z.number(),
  status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),
});

export const accountListSchema = z.array(accountSummarySchema);
export type AccountSummary = z.infer<typeof accountSummarySchema>;

/** One usage lane as the menu shows it: "Session 52% left · Resets in 3h 12m". */
export interface MenuWindow {
  label: string;
  usedPercent: number;
  resetAt: number | null;
  /** Null when the provider reported a window without its length. */
  windowMinutes: number | null;
}

export interface MenuAccount {
  id: string;
  /** Right-aligned header identity: the email, or the pool label when there is none. */
  identity: string;
  plan: string | null;
  priority: number;
  status: AccountSummary["status"];
  /** The best observable guess at the pool's active account. It drives the menu bar percent. */
  current: boolean;
  observedAt: number | null;
  heldUntil: number | null;
  error: string | null;
  inFlight: number;
  windows: MenuWindow[];
  /** Null until fetched, or when the account has none. */
  resetCredits?: ResetCredits | null;
  extraUsage?: ExtraUsage | null;
  resetNotice?: string | null;
  webResetCredits?: WebResetCredits | null;
}

export interface MenuProvider {
  id: "codex" | "claude";
  name: string;
  accounts: MenuAccount[];
}

/** Everything the native helper renders. */
export interface MenuSnapshot {
  providers: MenuProvider[];
  /** Why the last read failed, shown dimmed like CodexBar's stale state. */
  error: string | null;
}

const PROVIDERS = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
] as const;

const WINDOW_LABELS: Record<number, string> = { 300: "Session", 1440: "Daily", 10080: "Weekly" };
const WEEK_MINUTES = 10080;

/** 0..1 → 0..100, rounded to hundredths so 0.58 reads 58 rather than 57.99…. */
function percent(utilization: number): number {
  return Math.min(100, Math.max(0, Math.round(utilization * 10_000) / 100));
}

function windowLabel(minutes: number): string {
  return WINDOW_LABELS[minutes] ?? (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Codex reports up to two header or usage-endpoint windows, normally a session and a
 * weekly one. A window can arrive without its length; it keeps its slot name then.
 * An unknown-length window at 0% carries no information (the pool's placeholder
 * after a header names a reset but no window), so it is skipped.
 */
function codexWindows(account: AccountSummary): MenuWindow[] {
  return account.limitWindows
    .flatMap((window) => {
      const { utilization, windowMinutes } = window;
      if (utilization === null || (windowMinutes === null && utilization === 0)) return [];
      return [
        {
          label: windowMinutes === null ? capitalize(window.slot) : windowLabel(windowMinutes),
          usedPercent: percent(utilization),
          resetAt: window.resetAt,
          windowMinutes,
        },
      ];
    })
    .sort(
      (left, right) =>
        (left.windowMinutes ?? Number.POSITIVE_INFINITY) -
        (right.windowMinutes ?? Number.POSITIVE_INFINITY),
    );
}

/** Claude reports the shared 5h and 7d windows, then per-model weekly windows. */
function claudeWindows(account: AccountSummary): MenuWindow[] {
  const windows: MenuWindow[] = [];
  if (account.fiveHourUtilization !== null) {
    windows.push({
      label: "Session",
      usedPercent: percent(account.fiveHourUtilization),
      resetAt: account.fiveHourResetAt,
      windowMinutes: 300,
    });
  }
  if (account.sevenDayUtilization !== null) {
    windows.push({
      label: "Weekly",
      usedPercent: percent(account.sevenDayUtilization),
      resetAt: account.sevenDayResetAt,
      windowMinutes: WEEK_MINUTES,
    });
  }
  for (const [family, quota] of Object.entries(account.familyWeekly)) {
    if (quota === null || quota.utilization === null) continue;
    windows.push({
      label: capitalize(family),
      usedPercent: percent(quota.utilization),
      resetAt: quota.resetAt,
      windowMinutes: WEEK_MINUTES,
    });
  }
  return windows;
}

/** "default_claude_max_20x" → "20x", so a Max plan reads "Max 20x" like CodexBar's. */
function planName(account: AccountSummary): string | null {
  if (account.subscriptionType === null) return null;
  const multiplier = account.rateLimitTier?.match(/_(\d+x)$/)?.[1];
  const plan = capitalize(account.subscriptionType);
  return multiplier === undefined ? plan : `${plan} ${multiplier}`;
}

/**
 * The pool keeps routing to its current fallback until that account is unavailable,
 * but it does not expose which one that is, and affinity can pin threads elsewhere.
 * An account with requests in flight is in use now. Otherwise the latest recorded
 * use stands in, though the pool throttles `lastUsedAt` writes to once a minute.
 * Before any use, the first enabled account in priority order stands in.
 */
function currentAccountId(accounts: AccountSummary[]): string | null {
  const enabled = accounts.filter((account) => account.enabled);
  const busy = enabled.filter((account) => account.inFlight > 0);
  const candidates = busy.length > 0 ? busy : enabled;
  let current = candidates[0] ?? null;
  for (const account of candidates) {
    if ((account.lastUsedAt ?? -1) > (current?.lastUsedAt ?? -1)) current = account;
  }
  return current?.id ?? null;
}

export function poolProviders(accounts: AccountSummary[]): MenuProvider[] {
  return PROVIDERS.flatMap(({ id, name }) => {
    const owned = accounts
      .filter((account) => account.provider === id)
      .sort((left, right) => left.priority - right.priority);
    if (owned.length === 0) return [];
    const currentId = currentAccountId(owned);
    return [
      {
        id,
        name,
        accounts: owned.map((account) => ({
          id: account.id,
          identity: account.email ?? account.label,
          plan: planName(account),
          priority: account.priority,
          status: account.status,
          current: account.id === currentId,
          observedAt: account.observedAt,
          heldUntil: account.heldUntil,
          error: account.error,
          inFlight: account.inFlight,
          windows: id === "codex" ? codexWindows(account) : claudeWindows(account),
        })),
      },
    ];
  });
}
