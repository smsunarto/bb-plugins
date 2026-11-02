import type { GrokbotAction, SendOutcome, ThreadContext } from "../shared/contract.ts";
import type { GrokbotConfig } from "./config.ts";

/** One attempt, no retries: a slow router must not hold the panel. */
export const WEBHOOK_TIMEOUT_MS = 8_000;

export interface WebhookPayload {
  readonly action: GrokbotAction;
  readonly target_bot: string | null;
  readonly text: string;
  readonly context?: ThreadContext;
  readonly ts: string;
}

export function buildPayload(input: {
  action: GrokbotAction;
  targetBot: string | null;
  text: string;
  context: ThreadContext | null;
  now: Date;
}): WebhookPayload {
  return {
    action: input.action,
    target_bot: input.targetBot,
    text: input.text,
    ...(input.context ? { context: input.context } : {}),
    ts: input.now.toISOString(),
  };
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * POST the payload once. The result describes the failure in fixed words
 * plus an error code, so neither the URL nor the key can reach the browser
 * or the log through an error message.
 */
export async function postWebhook(
  config: Pick<GrokbotConfig, "url" | "key">,
  payload: WebhookPayload,
  options: { fetch?: Fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<SendOutcome> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  try {
    const response = await doFetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`,
        "X-Automation-Key": config.key,
      },
      body: JSON.stringify(payload),
      // A redirect could carry the key to another origin; report it instead.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is never read, so release the connection.
    await response.body?.cancel().catch(() => undefined);
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      error: ok ? null : httpError(response.status),
      durationMs: elapsed(),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: transportError(error, timeoutMs),
      durationMs: elapsed(),
    };
  }
}

function httpError(status: number): string {
  if (status >= 300 && status < 400) return `HTTP ${status} redirect (not followed)`;
  if (status === 401 || status === 403) return `HTTP ${status}: the router rejected the key`;
  if (status === 0) return "No HTTP status (opaque redirect)";
  return `HTTP ${status}`;
}

function transportError(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `Timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  const code = errorCode(error);
  return code ? `Network error (${code})` : "Network error";
}

/** A Node/undici error code such as ECONNREFUSED, from the error or its cause. */
function errorCode(error: unknown): string | null {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current !== "object") break;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
