// Jev (TypeSafe's classifier model), reached through either gateway that
// serves it. Both take a `state` and typed questions and return a choice with
// probabilities; they differ in URL, headers, and where the confidence sits.
//
// - Vercel AI Gateway only serves evaluation models over the AI SDK's wire
//   protocol, so this speaks that protocol with fetch rather than bundling the
//   SDK. That also sidesteps the SDK rejecting near-tied answers whose rounded
//   probabilities put the pick second.
// - OpenRouter serves Jev from its Decisions endpoint.
import { z } from "zod";
import { DEFAULT_JEV_MODELS } from "./preferences";
import { jevTransport } from "./transport";

export type JevProvider = "vercel" | "openrouter";

export const JEV_PROVIDERS: Record<
  JevProvider,
  { name: string; url: string; defaultModel: string; keysUrl: string }
> = {
  vercel: {
    name: "Vercel AI Gateway",
    url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    defaultModel: DEFAULT_JEV_MODELS.vercel,
    keysUrl: "https://vercel.com/dashboard → AI Gateway → API keys",
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/alpha/decisions",
    defaultModel: DEFAULT_JEV_MODELS.openrouter,
    keysUrl: "https://openrouter.ai/keys",
  },
};

/** Jev's documented ceiling on options per choice question. */
export const MAX_CHOICE_OPTIONS = 255;

const DEFAULT_TIMEOUT_MS = 8_000;

export type JevErrorCode =
  | "auth"
  | "no_credit"
  | "rate_limited"
  | "timeout"
  | "bad_response"
  | "failed";

export class JevError extends Error {
  constructor(
    readonly code: JevErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface ChoiceQuestion {
  /** What Jev is deciding, as one imperative sentence or two. */
  instructions: string;
  /** Option name → what picking it means. Jev reads both. */
  options: Record<string, string | null>;
}

export interface ChoiceAnswer {
  choice: string;
  /** Probability per option; empty when the gateway omitted the distribution. */
  probabilities: Record<string, number>;
  /** TypeSafe's calibrated confidence in the pick, when reported. */
  confidence: number | null;
  inputTokens: number | null;
  latencyMs: number;
}

export type JevState = string | { [key: string]: unknown };

export interface AskChoicesArgs {
  provider: JevProvider;
  apiKey: string;
  model: string;
  state: JevState;
  /**
   * Every question to answer about `state`, by caller-chosen key. Jev answers
   * them side by side in one request, in about the time it takes to answer one.
   */
  questions: Record<string, ChoiceQuestion>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Send with this fetch instead of the shared warm connection. For tests. */
  fetchImpl?: typeof fetch;
}

export type AskChoiceArgs = Omit<AskChoicesArgs, "questions"> & { question: ChoiceQuestion };

/** Wire ids are plain, whatever characters the caller's keys contain. */
const wireId = (index: number) => `q${index}`;

const answerSchema = z.object({
  type: z.string(),
  choice: z.string().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().optional(),
});

// Vercel reports usage in camelCase and confidence under provider metadata;
// OpenRouter reports usage in snake_case and confidence on the answer.
const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({ inputTokens: z.number().optional(), input_tokens: z.number().optional() })
    .optional(),
  providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

function buildRequest(args: AskChoicesArgs): { headers: Record<string, string>; body: unknown } {
  const base = {
    Authorization: `Bearer ${args.apiKey}`,
    "Content-Type": "application/json",
  };
  // OpenRouter's schema wants a string for every option; Vercel accepts null.
  const questions = Object.fromEntries(
    Object.values(args.questions).map((question, index) => [
      wireId(index),
      {
        type: "choice",
        instructions: question.instructions,
        criteria:
          args.provider === "openrouter"
            ? Object.fromEntries(
                Object.entries(question.options).map(([name, text]) => [name, text ?? ""]),
              )
            : question.options,
      },
    ]),
  );
  if (args.provider === "openrouter") {
    return {
      headers: { ...base, "X-Title": "BB Magic Compose" },
      body: { model: args.model, state: args.state, questions },
    };
  }
  return {
    headers: {
      ...base,
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": args.model,
    },
    body: { state: args.state, questions },
  };
}

function errorMessageFromBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string") return error;
      if (error !== null && typeof error === "object") {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") return message;
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.trim().slice(0, 300);
}

function errorForStatus(provider: JevProvider, status: number, body: string): JevError {
  const { name } = JEV_PROVIDERS[provider];
  const detail = errorMessageFromBody(body);
  if (status === 401 || status === 403) {
    return new JevError(
      "auth",
      `${name} rejected the API key (HTTP ${status}). Check the key in Magic Compose settings.`,
    );
  }
  if (status === 402) {
    return new JevError("no_credit", `${name} says the account is out of credit (HTTP 402).`);
  }
  if (status === 429 || status === 529) {
    return new JevError(
      "rate_limited",
      provider === "vercel"
        ? `The Vercel AI Gateway rate-limited Jev (HTTP ${status}). The free tier allows about 10 Jev calls per 5 minutes; add Gateway credits to lift it.`
        : `OpenRouter rate-limited Jev (HTTP ${status}).`,
    );
  }
  return new JevError(
    "failed",
    `Jev request to ${name} failed (HTTP ${status})${detail === "" ? "" : `: ${detail}`}`,
  );
}

function confidenceFrom(
  id: string,
  answer: z.infer<typeof answerSchema>,
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): number | null {
  if (answer.confidence !== undefined) return answer.confidence;
  const confidence = providerMetadata?.typesafe?.confidence;
  if (confidence === null || typeof confidence !== "object") return null;
  const value = (confidence as Record<string, unknown>)[id];
  return typeof value === "number" ? value : null;
}

function argmax(probabilities: Record<string, number>): string | null {
  let best: string | null = null;
  let bestValue = -Infinity;
  for (const [option, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      best = option;
      bestValue = value;
    }
  }
  return best;
}

async function requestOnce(
  args: AskChoicesArgs,
  signal: AbortSignal,
): Promise<Record<string, ChoiceAnswer>> {
  const startedAt = Date.now();
  const { headers, body: requestBody } = buildRequest(args);
  const { url } = JEV_PROVIDERS[args.provider];
  const payload = JSON.stringify(requestBody);
  let status: number;
  let body: string;
  if (args.fetchImpl === undefined) {
    ({ status, body } = await jevTransport.post(url, headers, payload, signal));
  } else {
    const response = await args.fetchImpl(url, { method: "POST", signal, headers, body: payload });
    status = response.status;
    body = await response.text();
  }
  if (status < 200 || status >= 300) {
    const error = errorForStatus(args.provider, status, body);
    // 5xx is worth one more try; everything else is the caller's to fix.
    if (status >= 500 && status !== 529) {
      throw new Error(error.message);
    }
    throw error;
  }

  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(JSON.parse(body));
  } catch {
    throw new JevError("bad_response", "Jev returned a response Magic Compose could not read.");
  }
  const latencyMs = Date.now() - startedAt;
  const inputTokens = parsed.usage?.inputTokens ?? parsed.usage?.input_tokens ?? null;
  const result: Record<string, ChoiceAnswer> = {};
  for (const [index, [key, question]] of Object.entries(args.questions).entries()) {
    const id = wireId(index);
    const answer = parsed.answers[id];
    if (answer === undefined || answer.type !== "choice") {
      throw new JevError("bad_response", "Jev did not answer every question.");
    }
    const probabilities: Record<string, number> = {};
    for (const [option, value] of Object.entries(answer.probabilities ?? {})) {
      if (Object.hasOwn(question.options, option)) probabilities[option] = value;
    }
    const choice =
      answer.choice !== undefined && Object.hasOwn(question.options, answer.choice)
        ? answer.choice
        : argmax(probabilities);
    if (choice === null) {
      throw new JevError("bad_response", "Jev picked an option that was not offered.");
    }
    result[key] = {
      choice,
      probabilities,
      confidence: confidenceFrom(id, answer, parsed.providerMetadata),
      // Usage is reported for the request as a whole.
      inputTokens,
      latencyMs,
    };
  }
  return result;
}

/** Ask Jev every question in `questions` about `state`, in one request. */
export async function askChoices(args: AskChoicesArgs): Promise<Record<string, ChoiceAnswer>> {
  if (Object.keys(args.questions).length === 0) return {};
  for (const question of Object.values(args.questions)) {
    const optionCount = Object.keys(question.options).length;
    if (optionCount === 0) {
      throw new JevError("failed", "Jev needs at least one option to choose from.");
    }
    if (optionCount > MAX_CHOICE_OPTIONS) {
      throw new JevError(
        "failed",
        `Jev accepts at most ${MAX_CHOICE_OPTIONS} options; got ${optionCount}.`,
      );
    }
  }

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = args.signal === undefined ? timeout : AbortSignal.any([args.signal, timeout]);
    try {
      return await requestOnce(args, signal);
    } catch (error) {
      if (args.signal?.aborted) throw error;
      if (timeout.aborted) {
        lastError = new JevError("timeout", `Jev did not answer within ${timeoutMs / 1000}s.`);
        continue;
      }
      if (error instanceof JevError) throw error;
      lastError = error;
    }
  }
  if (lastError instanceof JevError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new JevError(
    "failed",
    `Could not reach Jev on ${JEV_PROVIDERS[args.provider].name}: ${message}`,
  );
}

export interface JevRoute {
  provider: JevProvider;
  apiKey: string;
  model: string;
}

/**
 * Ask through the first route, and through the next when that one is
 * unavailable. A rejected key or an unreadable answer is a setup problem on
 * that route, so it moves on too; only the last route's error is reported.
 */
export async function askChoicesVia(
  routes: readonly JevRoute[],
  args: Omit<AskChoicesArgs, keyof JevRoute>,
): Promise<Record<string, ChoiceAnswer>> {
  let lastError: unknown = new JevError("failed", "No Jev API key is configured.");
  for (const route of routes) {
    try {
      return await askChoices({ ...args, ...route });
    } catch (error) {
      if (args.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Ask Jev one multiple-choice question about `state`. */
export async function askChoice(args: AskChoiceArgs): Promise<ChoiceAnswer> {
  const { question, ...rest } = args;
  const answers = await askChoices({ ...rest, questions: { only: question } });
  const answer = answers.only;
  if (answer === undefined) throw new JevError("bad_response", "Jev did not answer the question.");
  return answer;
}

/**
 * Open the connection to each route's gateway ahead of need. A new connection
 * is primed with one trivial question, a few hundred tokens, so that the slow
 * first request is not the user's.
 */
export async function warmRoutes(routes: readonly JevRoute[]): Promise<void> {
  await Promise.all(
    routes.map((route) =>
      jevTransport.warm(JEV_PROVIDERS[route.provider].url, () =>
        askChoices({
          ...route,
          state: "Warming up the connection.",
          questions: {
            ready: {
              instructions: "Is the connection ready?",
              options: { yes: "Ready.", no: "Not ready." },
            },
          },
        }),
      ),
    ),
  );
}
