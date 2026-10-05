import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ExtrasUpdate } from "./extras.ts";

const CLI = "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI";
const FRESH_MS = 5 * 60_000;
/**
 * How late the next refresh can land after the 5-minute extras cadence: the 15 s
 * menu poll, the 10 s OAuth timeout, and the 20 s CLI timeout, with slack.
 */
const REFRESH_HEADROOM_MS = 90_000;
const exec = promisify(execFile);

/** CodexBar exposes display text, not grant handles or exact expiry timestamps. */
export interface WebResetCredits {
  count: number;
  expiry: string | null;
  freshUntil: number;
}

interface WebUsage {
  email: string;
  credits: WebResetCredits;
}

const payloadSchema = z.array(
  z.object({
    provider: z.string(),
    source: z.string(),
    usage: z
      .object({
        accountEmail: z.string().nullish(),
        identity: z.object({ accountEmail: z.string().nullish() }).nullish(),
        updatedAt: z.string(),
        details: z.array(
          z.object({
            rows: z.array(
              z.object({
                label: z.string(),
                value: z.string(),
                secondaryValue: z.string().max(160).nullish(),
              }),
            ),
          }),
        ),
      })
      .nullish(),
  }),
);

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && z.email().safeParse(email).success ? email : null;
}

function validExpiry(value: string | null): boolean {
  return (
    value === null ||
    (value.startsWith("Expires ") && !Array.from(value).some((char) => char.charCodeAt(0) < 32))
  );
}

/** Only fresh, unambiguous Claude web output can cross into the native display. */
export function parseClaudeWeb(body: unknown, now: number): WebUsage | null {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) return null;
  const entries = parsed.data.filter(
    (entry) => entry.provider === "claude" && entry.source === "web",
  );
  if (entries.length !== 1) return null;
  const usage = entries[0]?.usage;
  if (!usage) return null;
  const email = normalizeEmail(usage.accountEmail ?? usage.identity?.accountEmail);
  const identityEmail = normalizeEmail(usage.identity?.accountEmail);
  if (!email || (identityEmail && email !== identityEmail)) return null;
  const updatedAt = Date.parse(usage.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt > now + 30_000 || now - updatedAt >= FRESH_MS)
    return null;
  const rows = usage.details
    .flatMap((section) => section.rows)
    .filter((row) => row.label === "Limit Reset Credits");
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const count = Number(row.value.match(/^(\d{1,2}) available$/)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 50) return null;
  const expiry = row.secondaryValue ?? null;
  if (!validExpiry(expiry)) return null;
  // A reading up to FRESH_MS old must stay fresh natively until the next refresh lands,
  // otherwise the row flips off between refreshes.
  const freshUntil = updatedAt + 2 * FRESH_MS + REFRESH_HEADROOM_MS;
  return { email, credits: { count, expiry, freshUntil } };
}

async function fetchWeb(signal: AbortSignal): Promise<unknown> {
  const { stdout } = await exec(
    CLI,
    [
      "usage",
      "--provider",
      "claude",
      "--source",
      "web",
      "--json",
      "--log-level",
      "error",
      "--web-timeout",
      "15",
    ],
    { signal, timeout: 20_000, maxBuffer: 1_048_576 },
  );
  return JSON.parse(stdout);
}

/** Cache failures too. One service-owned reader shares a bounded CLI request across accounts. */
export function createClaudeWebReader(
  fetchUsage: (signal: AbortSignal) => Promise<unknown> = fetchWeb,
  now: () => number = Date.now,
) {
  let cache: { at: number; value: WebUsage | null } | null = null;
  let pending: Promise<WebUsage | null> | null = null;
  return (signal: AbortSignal, refresh: boolean): Promise<WebUsage | null> => {
    if (pending) return pending;
    if (!refresh && cache && now() - cache.at < FRESH_MS) {
      return Promise.resolve(
        cache.value && now() < cache.value.credits.freshUntil ? cache.value : null,
      );
    }
    pending = fetchUsage(signal)
      .then((body) => parseClaudeWeb(body, now()))
      .catch(() => null)
      .then((value) => {
        cache = { at: now(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

export type ClaudeWebReader = ReturnType<typeof createClaudeWebReader>;

/**
 * Email is the CLI's only identity. Duplicate pool emails, including disabled accounts,
 * are ambiguous. Credits OAuth reported leave the update as read. When OAuth failed
 * transiently, the update carries only the web fields and merges onto the kept ones.
 */
export function withClaudeWeb(
  extras: ExtrasUpdate,
  accountId: string,
  accounts: { id: string; email: string | null | undefined }[],
  web: WebUsage | null,
): ExtrasUpdate {
  if (extras.resetCredits != null) return extras;
  const unmatched = { ...extras, webResetCredits: null };
  if (!web) return unmatched;
  const matches = accounts.filter((account) => normalizeEmail(account.email) === web.email);
  if (matches.length !== 1 || matches[0]?.id !== accountId) return unmatched;
  // Keep the link as a fallback once the native clock expires this short-lived observation.
  return {
    ...extras,
    webResetCredits: web.credits,
    resetNotice: extras.resetNotice ?? "Check Claude for full resets",
  };
}
