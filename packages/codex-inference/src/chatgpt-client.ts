import type { JsonValue } from "@get-bb/plugin-sdk";
import type {
  CodexInferenceInput,
  CodexInferenceOutput,
  CodexInferenceErrorCode,
} from "./contract.ts";
import {
  parseJsonValue,
  readCodexAuthCredentials,
  type CodexAuthCredentials,
  type JsonObject,
} from "./codex-auth.ts";
import { AiServiceFailure } from "./failure.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** A title is a few hundred bytes; anything past this is not a title. */
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

interface CodexStreamFailure {
  code: string | null;
  message: string;
}

function jsonObject(value: JsonValue | undefined): JsonObject | null {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function createHeaders(auth: CodexAuthCredentials): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${auth.type === "chatgpt" ? auth.accessToken : auth.apiKey}`,
    "User-Agent": "bb-host-daemon",
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  if (auth.type === "chatgpt") {
    headers.set("chatgpt-account-id", auth.accountId);
    headers.set("originator", "bb");
    headers.set("OpenAI-Beta", "responses=experimental");
    if (auth.isFedrampAccount) {
      headers.set("X-OpenAI-Fedramp", "true");
    }
  }
  return headers;
}

function invalidResponse(message: string): AiServiceFailure {
  return new AiServiceFailure("invalid_response", message);
}

function codexRequestErrorCode(status: number): CodexInferenceErrorCode {
  if (status === 401) return "auth_required";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unavailable";
  return "request_failed";
}

const CODEX_SERVICE_UNAVAILABLE_PATTERN =
  /\b(?:overloaded|temporarily unavailable|try again later)\b/iu;

function codexStreamFailureErrorCode(failure: CodexStreamFailure): CodexInferenceErrorCode {
  if (failure.code === "server_error") return "service_unavailable";
  if (failure.code === "rate_limit_exceeded") return "rate_limited";
  return CODEX_SERVICE_UNAVAILABLE_PATTERN.test(failure.message)
    ? "service_unavailable"
    : "request_failed";
}

/** api.openai.com answers `{"error":{"message"}}`; the ChatGPT backend answers `{"detail"}`. */
function providerErrorMessage(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  try {
    const body = jsonObject(parseJsonValue(text));
    const detail = body?.error ?? body?.detail;
    return (
      (typeof detail === "string" ? detail : optionalString(jsonObject(detail)?.message)) ?? text
    );
  } catch {
    return text;
  }
}

function isCloudflareChallenge(response: Response): boolean {
  return (
    response.status === 403 && response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
  );
}

function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().startsWith("text/html") ?? false;
}

async function createCodexHttpError(response: Response): Promise<AiServiceFailure> {
  const prefix = `Codex inference request failed with HTTP ${response.status}`;
  if (isCloudflareChallenge(response)) {
    return new AiServiceFailure(
      "service_unavailable",
      `${prefix}: chatgpt.com answered with a Cloudflare challenge that this plugin cannot solve. Retry, or log in to Codex with an OpenAI API key so requests go to api.openai.com instead.`,
    );
  }
  let body = "";
  if (!isHtmlResponse(response)) {
    try {
      body = await response.text();
    } catch {
      // The status code already names the failure; the body is only a detail.
    }
  }
  const message = providerErrorMessage(body);
  const detail =
    message === null ? "" : `: ${message.length > 400 ? `${message.slice(0, 400)}...` : message}`;
  return new AiServiceFailure(codexRequestErrorCode(response.status), `${prefix}${detail}`);
}

function streamFailure(error: JsonObject | null, fallback: string | null): AiServiceFailure {
  const code = optionalString(error?.code);
  const failure = {
    code,
    message: optionalString(error?.message) ?? code ?? fallback ?? "Codex response failed",
  };
  return new AiServiceFailure(codexStreamFailureErrorCode(failure), failure.message);
}

/**
 * The text an event contributes to the answer. The ChatGPT backend's terminal
 * event carries no output text, so the deltas are the one source of it; the
 * terminal events matter only for the failure they may report.
 */
function textFromSseEvent(event: JsonObject): string {
  const type = optionalString(event.type);
  if (type === "error") {
    throw streamFailure(event, null);
  }
  if (type === "response.failed") {
    throw streamFailure(jsonObject(jsonObject(event.response)?.error), null);
  }
  if (type === "response.completed" || type === "response.done") {
    const error = jsonObject(jsonObject(event.response)?.error);
    if (error) throw streamFailure(error, null);
  }
  return type === "response.output_text.delta" ? (optionalString(event.delta) ?? "") : "";
}

/** The JSON payload of one SSE block, or null for a comment or `[DONE]`. */
function parseSseBlock(block: string): JsonObject | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    return jsonObject(parseJsonValue(data));
  } catch {
    throw invalidResponse("Codex SSE event was not valid JSON.");
  }
}

/** The structured output text of a streamed Responses API call. */
export async function readInferenceResponse(
  response: Response,
  maxBytes: number = RESPONSE_MAX_BYTES,
): Promise<string> {
  if (!response.body) {
    throw invalidResponse("Codex response did not include a response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let totalBytes = 0;

  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        throw invalidResponse("Codex response exceeded the maximum supported size.");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let index = buffer.indexOf("\n\n"); index !== -1; index = buffer.indexOf("\n\n")) {
        const event = parseSseBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        if (event) text += textFromSseEvent(event);
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }

  if (!text) {
    throw invalidResponse("Codex response did not include structured output text.");
  }
  return text;
}

function parseStructuredResult(rawText: string): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = parseJsonValue(rawText);
  } catch {
    throw invalidResponse("Codex structured output was not valid JSON.");
  }
  const object = jsonObject(parsed);
  if (!object) {
    throw invalidResponse("Codex structured output was not a JSON object.");
  }
  return object;
}

export function buildRequestBody(command: CodexInferenceInput): string {
  return JSON.stringify({
    model: command.model,
    instructions:
      "Follow the user prompt and respond with structured JSON that matches the requested schema.",
    reasoning: { effort: command.reasoningEffort ?? "none" },
    store: false,
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: command.prompt }] }],
    text: {
      format: { type: "json_schema", name: "result", strict: true, schema: command.outputSchema },
    },
  });
}

export async function completeCodexInference(
  command: CodexInferenceInput,
): Promise<Extract<CodexInferenceOutput, { ok: true }>> {
  const auth = await readCodexAuthCredentials();
  // One signal covers the connection and the body: a stalled stream aborts too.
  const signal = AbortSignal.timeout(command.timeoutMs);
  try {
    const response = await fetch(
      auth.type === "chatgpt" ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL,
      { method: "POST", headers: createHeaders(auth), body: buildRequestBody(command), signal },
    );
    if (!response.ok) {
      throw await createCodexHttpError(response);
    }
    const text = await readInferenceResponse(response);
    return { ok: true, model: command.model, value: parseStructuredResult(text) };
  } catch (error) {
    if (signal.aborted) {
      throw new AiServiceFailure("timeout", `Codex request timed out after ${command.timeoutMs}ms`);
    }
    throw error;
  }
}
