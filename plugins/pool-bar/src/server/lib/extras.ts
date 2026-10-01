import { z } from "zod";
import type { WebResetCredits } from "./claude-web.ts";

/**
 * Quota extras bb does not model: limit reset credits for both providers, Codex's
 * credit balance, and Claude's extra-usage spend. Fetched straight from the provider endpoints CodexBar
 * uses, with an access token the caller supplies. Every function here returns null
 * rather than throwing, so one failing account never blanks the menu.
 */

/** Unredeemed, unexpired reset credits, soonest expiry first; null expiry never lapses. */
export interface ResetCredits {
  expiries: (number | null)[];
}

export type ExtraUsage =
  /** Codex: prepaid credits, a raw count rather than currency. */
  | { kind: "balance"; balance: number }
  /** Claude: spend against a monthly cap, in currency units. */
  | { kind: "spend"; used: number; limit: number; currency: string };

export interface AccountExtras {
  resetCredits: ResetCredits | null;
  extraUsage: ExtraUsage | null;
  resetNotice?: string | null;
  webResetCredits?: WebResetCredits | null;
}

export const NO_EXTRAS: AccountExtras = { resetCredits: null, extraUsage: null };

const CODEX_BASE = "https://chatgpt.com/backend-api";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 10_000;

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ body: unknown; status: number }> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { body: response.ok ? await response.json() : null, status: response.status };
  } catch {
    return { body: null, status: 0 };
  }
}

const resetCreditsSchema = z.object({
  credits: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      expires_at: z.string().nullish(),
    }),
  ),
});

export function parseResetCredits(body: unknown, now: number): ResetCredits | null {
  const parsed = resetCreditsSchema.safeParse(body);
  if (!parsed.success) return null;
  const expiries = parsed.data.credits
    .filter((credit) => credit.status === "available")
    .map((credit) => (credit.expires_at ? Date.parse(credit.expires_at) : null))
    .filter((expiry) => expiry === null || (Number.isFinite(expiry) && expiry > now))
    .sort((left, right) => (left ?? Infinity) - (right ?? Infinity));
  return expiries.length === 0 ? null : { expiries };
}

const balanceSchema = z.union([z.number(), z.string()]).nullish();

const codexCreditsSchema = z.object({
  credits: z
    .object({
      has_credits: z.boolean().nullish(),
      unlimited: z.boolean().nullish(),
      balance: balanceSchema,
    })
    .nullish(),
});

function toNumber(value: z.infer<typeof balanceSchema>): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** The balance on `wham/usage`, or null when the account must ask `remaining_balance`. */
export function parseCodexBalance(body: unknown): { balance: number | null; ask: boolean } {
  const credits = codexCreditsSchema.safeParse(body).data?.credits;
  if (!credits?.has_credits || credits.unlimited) return { balance: null, ask: false };
  const balance = toNumber(credits.balance);
  return { balance, ask: balance === null };
}

const monthlyLimitSchema = z
  .object({
    limit: balanceSchema,
    used: balanceSchema,
    remaining_percent: balanceSchema,
    remainingPercent: balanceSchema,
  })
  .nullable()
  .catch(null);

/** Included monthly credits are quota, not purchased extra credits. */
export function purchasedCodexBalance(body: unknown, balance: number | null): number | null {
  const parsed = z
    .object({
      individual_limit: monthlyLimitSchema,
      individualLimit: monthlyLimitSchema,
      rate_limit: z
        .object({ individual_limit: monthlyLimitSchema, individualLimit: monthlyLimitSchema })
        .nullish(),
      spendControl: z
        .object({ individual_limit: monthlyLimitSchema, individualLimit: monthlyLimitSchema })
        .nullish(),
      spend_control: z
        .object({ individual_limit: monthlyLimitSchema, individualLimit: monthlyLimitSchema })
        .nullish(),
    })
    .safeParse(body).data;
  const monthly =
    parsed?.individual_limit ??
    parsed?.individualLimit ??
    parsed?.rate_limit?.individual_limit ??
    parsed?.rate_limit?.individualLimit ??
    parsed?.spend_control?.individual_limit ??
    parsed?.spend_control?.individualLimit ??
    parsed?.spendControl?.individual_limit ??
    parsed?.spendControl?.individualLimit;
  if (!monthly || balance === null) return balance;
  const limit = toNumber(monthly.limit);
  if (limit === null || limit <= 0) return balance;
  const used = toNumber(monthly.used);
  const percent = toNumber(monthly.remaining_percent ?? monthly.remainingPercent);
  const remaining =
    used !== null ? Math.max(0, limit - used) : percent !== null ? (limit * percent) / 100 : null;
  return remaining !== null && Math.abs(balance - remaining) < 0.0001 ? null : balance;
}

export async function codexExtras(token: string, accountId: string | null): Promise<AccountExtras> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "bb-pool-bar",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };
  const [creditsBody, usageBody] = await Promise.all([
    getJson(`${CODEX_BASE}/wham/rate-limit-reset-credits`, {
      ...headers,
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    }),
    getJson(`${CODEX_BASE}/wham/usage`, headers),
  ]);
  let { balance, ask } = parseCodexBalance(usageBody.body);
  if (!ask) balance = purchasedCodexBalance(usageBody.body, balance);
  // Workspace accounts leave the balance off `wham/usage` and report it here.
  if (ask && accountId) {
    const body = await getJson(`${CODEX_BASE}/accounts/${accountId}/remaining_balance`, headers);
    balance = toNumber(z.object({ balance: balanceSchema }).safeParse(body.body).data?.balance);
  }
  return {
    resetCredits: parseResetCredits(creditsBody.body, Date.now()),
    extraUsage: balance !== null && balance > 0 ? { kind: "balance", balance } : null,
  };
}

const claudeUsageSchema = z.object({
  extra_usage: z
    .object({
      is_enabled: z.boolean().nullish(),
      monthly_limit: z.number().nullish(),
      used_credits: z.number().nullish(),
      currency: z.string().nullish(),
      decimal_places: z.number().int().min(0).max(6).nullish(),
    })
    .nullish(),
});

/** Claude reports extra usage in minor units: cents unless `decimal_places` says otherwise. */
export function parseClaudeExtraUsage(body: unknown): ExtraUsage | null {
  const extra = claudeUsageSchema.safeParse(body).data?.extra_usage;
  if (!extra?.is_enabled || extra.monthly_limit == null || extra.used_credits == null) return null;
  if (extra.monthly_limit <= 0) return null;
  const scale = 10 ** (extra.decimal_places ?? 2);
  return {
    kind: "spend",
    used: extra.used_credits / scale,
    limit: extra.monthly_limit / scale,
    currency: extra.currency ?? "USD",
  };
}

/** Observed grants hold one reset each; a larger inventory is treated as malformed. */
const MAX_CLAUDE_RESETS = 50;

const claudeGrantSchema = z
  .object({
    resets_left: z.number().int().min(0),
    starts_at: z.string().nullish(),
    ends_at: z.string().nullish(),
    paused: z.boolean(),
  })
  .transform((grant) => ({
    resetsLeft: grant.resets_left,
    paused: grant.paused,
    startsAt: grant.starts_at ? Date.parse(grant.starts_at) : null,
    endsAt: grant.ends_at ? Date.parse(grant.ends_at) : null,
  }))
  .refine((grant) => !Number.isNaN(grant.startsAt) && !Number.isNaN(grant.endsAt));

const claudeResetsSchema = z.object({
  cedar_ember: z.object({ eligible: z.boolean(), grants: z.array(z.unknown()).nullish() }),
});

/**
 * Claude's free usage-limit resets, from the `cedar_ember` block `?cedar_ember=1`
 * adds to the usage response. Each grant contributes one entry per reset left;
 * paused, used-up, not-yet-started, and expired grants are left out, as CodexBar does.
 */
export function parseClaudeResetCredits(body: unknown, now: number): ResetCredits | null {
  const block = claudeResetsSchema.safeParse(body).data?.cedar_ember;
  if (!block?.eligible) return null;
  const expiries: (number | null)[] = [];
  for (const raw of block.grants ?? []) {
    const grant = claudeGrantSchema.safeParse(raw).data;
    if (!grant || grant.paused || grant.resetsLeft === 0) continue;
    if (grant.startsAt !== null && grant.startsAt > now) continue;
    if (grant.endsAt !== null && grant.endsAt <= now) continue;
    if (expiries.length + grant.resetsLeft > MAX_CLAUDE_RESETS) return null;
    for (let index = 0; index < grant.resetsLeft; index += 1) expiries.push(grant.endsAt);
  }
  expiries.sort((left, right) => (left ?? Infinity) - (right ?? Infinity));
  return expiries.length === 0 ? null : { expiries };
}

export async function claudeExtras(token: string): Promise<AccountExtras> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.0",
  };
  // An account the reset opt-in is rejected for still reports extra usage without it.
  let response = await getJson(`${CLAUDE_USAGE_URL}?cedar_ember=1`, headers);
  // Retry only a rejected opt-in. Authentication failures, throttling, and server
  // failures must wait for the next scheduled refresh.
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    response = await getJson(CLAUDE_USAGE_URL, headers);
  }
  const { body } = response;
  const surface = z
    .object({ cedar_ember: z.object({ ineligible_reason: z.string().nullish() }).nullish() })
    .safeParse(body).data;
  return {
    resetCredits: parseClaudeResetCredits(body, Date.now()),
    extraUsage: parseClaudeExtraUsage(body),
    resetNotice:
      surface?.cedar_ember?.ineligible_reason === "surface" ? "Check Claude for full resets" : null,
  };
}
