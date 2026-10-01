import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

/**
 * Access tokens for the extras endpoints. Every reader here is read-only and never
 * refreshes: refreshing would rotate a refresh token that Account Pooler or the
 * CLI owns. An expired token yields null, and the account shows no extras until
 * its owner refreshes it.
 */

const run = promisify(execFile);

export interface LocalCredential {
  token: string;
  /** Codex's ChatGPT account id, sent as ChatGPT-Account-Id. */
  accountId: string | null;
  email: string | null;
  /** Same namespaced account identity as provider-usage.v1. */
  accountKey: string | null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function jwtPayload(token: string | null | undefined): Record<string, unknown> {
  try {
    const payload = token?.split(".")[1];
    return payload
      ? (z
          .record(z.string(), z.unknown())
          .safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).data ?? {})
      : {};
  } catch {
    return {};
  }
}

function jwtLive(token: string, now: number): boolean {
  const exp = jwtPayload(token).exp;
  return typeof exp !== "number" || exp * 1000 > now;
}

const poolSecretSchema = z.object({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  expiresAt: z.number().nullable(),
});

/**
 * Account Pooler's stored OAuth token for one account. This reads its private
 * secret layout (`<dataDir>/plugins/account-pool/secrets/accounts/account-<id>.json`,
 * bb `plugins/account-pool/src/store.ts`). If that layout changes, extras for pool
 * accounts silently disappear while quota keeps working.
 */
export async function poolToken(dataDir: string, accountId: string): Promise<string | null> {
  if (!/^[a-z0-9_-]+$/iu.test(accountId)) return null;
  const path = join(
    dataDir,
    "plugins",
    "account-pool",
    "secrets",
    "accounts",
    `account-${accountId}.json`,
  );
  const secret = poolSecretSchema.safeParse(await readJson(path)).data;
  if (!secret) return null;
  const now = Date.now();
  if (secret.expiresAt !== null && secret.expiresAt <= now) return null;
  return jwtLive(secret.accessToken, now) ? secret.accessToken : null;
}

const codexAuthSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().nullish(),
    id_token: z.string().nullish(),
  }),
});

/** The Codex CLI's signed-in account, from `$CODEX_HOME/auth.json`. */
export function parseCodexCredential(body: unknown): LocalCredential | null {
  const auth = codexAuthSchema.safeParse(body).data;
  if (!auth || !jwtLive(auth.tokens.access_token, Date.now())) return null;
  const idClaims = jwtPayload(auth.tokens.id_token);
  const accessClaims = jwtPayload(auth.tokens.access_token)["https://api.openai.com/auth"];
  const idAuthClaims = idClaims["https://api.openai.com/auth"];
  const claimAccount = [accessClaims, idAuthClaims].flatMap((claims) =>
    typeof claims === "object" &&
    claims !== null &&
    typeof (claims as Record<string, unknown>).chatgpt_account_id === "string"
      ? [(claims as Record<string, string>).chatgpt_account_id]
      : [],
  )[0];
  const accountId = auth.tokens.account_id ?? claimAccount ?? null;
  return {
    token: auth.tokens.access_token,
    accountId,
    accountKey: accountId ? `openai:chatgpt:${accountId}` : null,
    email: typeof idClaims.email === "string" ? idClaims.email : null,
  };
}

export async function localCodex(): Promise<LocalCredential | null> {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return parseCodexCredential(await readJson(join(home, "auth.json")));
}

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
  }),
});

function parseClaude(raw: string): z.infer<typeof claudeCredentialsSchema>["claudeAiOauth"] | null {
  const trimmed = raw.trim();
  // Older Claude Code builds store the keychain item hex-encoded.
  const candidates = /^(?:[0-9a-f]{2})+$/iu.test(trimmed)
    ? [trimmed, Buffer.from(trimmed, "hex").toString("utf8")]
    : [trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = claudeCredentialsSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data.claudeAiOauth;
    } catch {}
  }
  return null;
}

/**
 * Claude Code's signed-in account: the macOS keychain item first, as bb's built-in
 * Claude provider reads it, then `~/.claude/.credentials.json`.
 */
export async function localClaude(): Promise<LocalCredential | null> {
  let credentials = null;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-a", userInfo().username, "-w"],
        { timeout: 10_000 },
      );
      credentials = parseClaude(stdout);
    } catch {}
  }
  if (credentials === null) {
    try {
      credentials = parseClaude(
        await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8"),
      );
    } catch {}
  }
  if (!credentials || (credentials.expiresAt != null && credentials.expiresAt <= Date.now())) {
    return null;
  }
  const account = z
    .object({
      oauthAccount: z
        .object({ emailAddress: z.string().nullish(), accountUuid: z.string().nullish() })
        .nullish(),
    })
    .safeParse(await readJson(join(homedir(), ".claude.json"))).data;
  return {
    token: credentials.accessToken,
    accountId: null,
    accountKey: account?.oauthAccount?.accountUuid
      ? `anthropic:account:${account.oauthAccount.accountUuid}`
      : null,
    email: account?.oauthAccount?.emailAddress ?? null,
  };
}
