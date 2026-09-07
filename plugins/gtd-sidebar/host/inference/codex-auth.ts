import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { AiServiceFailure } from "./failure.ts";

export type JsonObject = { [key: string]: JsonValue };

const CHATGPT_AUTH_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexChatGptAuthCredentials {
  type: "chatgpt";
  accessToken: string;
  accountId: string;
  isFedrampAccount: boolean;
}

export interface CodexOpenAiApiKeyCredentials {
  type: "apiKey";
  apiKey: string;
}

export type CodexAuthCredentials = CodexChatGptAuthCredentials | CodexOpenAiApiKeyCredentials;

function codexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(path.resolve(codexHome), "auth.json");
}

function toJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function nonEmptyString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `JSON.parse` can only produce a `JsonValue`; the cast records that. */
export function parseJsonValue(raw: string): JsonValue {
  return JSON.parse(raw) as JsonValue;
}

function chatGptClaims(token: string): JsonObject | null {
  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }
  try {
    const decoded = toJsonObject(
      parseJsonValue(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return toJsonObject(decoded?.[CHATGPT_AUTH_CLAIM_PATH]);
  } catch {
    return null;
  }
}

function authFailure(message: string): AiServiceFailure {
  return new AiServiceFailure("auth_required", `${message} Run codex login on this host.`);
}

async function readAuthFile(authPath: string): Promise<JsonObject> {
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw authFailure(
      missing
        ? `Codex auth file not found at ${authPath}.`
        : `Codex auth file at ${authPath} could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  let auth: JsonObject | null;
  try {
    auth = toJsonObject(parseJsonValue(raw));
  } catch {
    auth = null;
  }
  if (auth === null) {
    throw authFailure(`Codex auth file at ${authPath} is not valid JSON.`);
  }
  return auth;
}

export async function readCodexAuthCredentials(): Promise<CodexAuthCredentials> {
  const authPath = codexAuthPath();
  const auth = await readAuthFile(authPath);

  const authMode = nonEmptyString(auth.auth_mode);
  const apiKey = nonEmptyString(auth.OPENAI_API_KEY);
  if (authMode === "apikey" || authMode === "apiKey" || (authMode === null && apiKey !== null)) {
    if (apiKey === null) {
      throw authFailure(`Codex auth file at ${authPath} does not contain a usable API key.`);
    }
    return { type: "apiKey", apiKey };
  }

  const tokens = toJsonObject(auth.tokens);
  const accessToken = nonEmptyString(tokens?.access_token);
  if (tokens === null || accessToken === null) {
    throw authFailure(`Codex auth file at ${authPath} does not contain a usable access token.`);
  }
  const claims = chatGptClaims(accessToken);
  const idToken = nonEmptyString(tokens.id_token);
  const idTokenClaims = idToken === null ? null : chatGptClaims(idToken);
  const accountId =
    nonEmptyString(tokens.account_id) ??
    nonEmptyString(claims?.chatgpt_account_id) ??
    nonEmptyString(idTokenClaims?.chatgpt_account_id);
  if (accountId === null) {
    throw authFailure("Codex auth tokens do not include a ChatGPT account id.");
  }
  return {
    type: "chatgpt",
    accessToken,
    accountId,
    isFedrampAccount:
      claims?.chatgpt_account_is_fedramp === true ||
      idTokenClaims?.chatgpt_account_is_fedramp === true,
  };
}
