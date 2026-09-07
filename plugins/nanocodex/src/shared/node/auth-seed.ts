import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ChatGptCredentialSeed } from "nanocodex/host";

const MAX_AUTH_FILE_BYTES = 64 * 1024;
const MINIMUM_TTL_MS = 5 * 60_000;

export type AuthSeedStatus =
  | { readonly state: "ready"; readonly path: string; readonly seed: ChatGptCredentialSeed }
  | { readonly state: "missing"; readonly path: string; readonly message: string }
  | { readonly state: "expired" | "broken"; readonly path: string; readonly message: string };

export function codexAuthPath(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmpty(environment.NANOCODEX_AUTH_FILE);
  if (explicit !== undefined) return resolve(explicit);
  const codexHome = nonEmpty(environment.CODEX_HOME);
  return resolve(
    codexHome === undefined ? join(homedir(), ".codex", "auth.json") : join(codexHome, "auth.json"),
  );
}

export async function inspectAuthSeed(
  environment: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<AuthSeedStatus> {
  const path = codexAuthPath(environment);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch (error) {
    return {
      state: "missing",
      path,
      message: `Cannot open the Codex auth file: ${errorMessage(error)}`,
    };
  }

  try {
    const stat = await file.stat();
    if (!stat.isFile())
      return { state: "broken", path, message: "The Codex auth path is not a file." };
    if (stat.size > MAX_AUTH_FILE_BYTES) {
      return {
        state: "broken",
        path,
        message: `The Codex auth file exceeds ${MAX_AUTH_FILE_BYTES} bytes.`,
      };
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return {
        state: "broken",
        path,
        message: "The Codex auth file is accessible by group or other users.",
      };
    }
    const bytes = await file.readFile();
    if (bytes.byteLength > MAX_AUTH_FILE_BYTES) {
      return {
        state: "broken",
        path,
        message: `The Codex auth file exceeds ${MAX_AUTH_FILE_BYTES} bytes.`,
      };
    }
    return parseAuthSeed(bytes.toString("utf8"), path, now);
  } catch (error) {
    return {
      state: "broken",
      path,
      message: `Cannot read the Codex auth file: ${errorMessage(error)}`,
    };
  } finally {
    await file.close();
  }
}

export async function readAuthSeed(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ChatGptCredentialSeed | undefined> {
  const status = await inspectAuthSeed(environment);
  return status.state === "ready" ? status.seed : undefined;
}

function parseAuthSeed(encoded: string, path: string, now: number): AuthSeedStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    return {
      state: "broken",
      path,
      message: `Cannot parse the Codex auth file: ${errorMessage(error)}`,
    };
  }
  if (!isRecord(parsed) || parsed.auth_mode !== "chatgpt" || !isRecord(parsed.tokens)) {
    return {
      state: "missing",
      path,
      message: "The Codex auth file has no ChatGPT subscription login.",
    };
  }
  const accessToken = nonEmpty(parsed.tokens.access_token);
  if (accessToken === undefined) {
    return { state: "broken", path, message: "The Codex auth file has no access token." };
  }
  const idClaims = jwtPayload(nonEmpty(parsed.tokens.id_token));
  const accessClaims = jwtPayload(accessToken);
  const idAuth = nestedRecord(idClaims, "https://api.openai.com/auth");
  const accessAuth = nestedRecord(accessClaims, "https://api.openai.com/auth");
  const accountIds = [
    nonEmpty(parsed.tokens.account_id),
    nonEmpty(idAuth?.chatgpt_account_id),
    nonEmpty(accessAuth?.chatgpt_account_id),
  ].filter((value): value is string => value !== undefined);
  const accountId = accountIds[0];
  if (accountId === undefined || accountIds.some((candidate) => candidate !== accountId)) {
    return {
      state: "broken",
      path,
      message: "The Codex auth file has no consistent ChatGPT account ID.",
    };
  }
  const expiresAt = typeof accessClaims?.exp === "number" ? accessClaims.exp * 1_000 : undefined;
  if (expiresAt === undefined || expiresAt <= now + MINIMUM_TTL_MS) {
    return {
      state: "expired",
      path,
      message: "The Codex access token is expired or expires too soon.",
    };
  }
  const fedrampClaims = [
    optionalBoolean(idAuth?.chatgpt_account_is_fedramp),
    optionalBoolean(accessAuth?.chatgpt_account_is_fedramp),
  ].filter((value): value is boolean => value !== undefined);
  if (fedrampClaims.some((candidate) => candidate !== fedrampClaims[0])) {
    return {
      state: "broken",
      path,
      message: "The Codex auth file has conflicting FedRAMP claims.",
    };
  }
  const refreshToken = nonEmpty(parsed.tokens.refresh_token);
  return {
    state: "ready",
    path,
    seed: {
      accessToken,
      accountId,
      fedramp: fedrampClaims[0] ?? false,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    },
  };
}

function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const encoded = token?.split(".")[1];
  if (encoded === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function nestedRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value?.[key];
  return isRecord(nested) ? nested : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
