import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GtdSidebarCodexResult, GtdSidebarHostClient } from "./lib/host-contract.ts";

// The models of bb's own Codex AI service (plugins/provider-codex/src/ai-service.ts).
export const TITLE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const;
const INFERENCE_TIMEOUT_MS = 5_000;
const HOST_CALL_GRACE_MS = 1_000;
// bb cannot retry a timeout inside its single 5 s task deadline. GTD has no such
// deadline, and a cold first request can miss 5 s.
const RETRY_WITH_NEXT_MODEL = new Set([
  "timeout",
  "rate_limited",
  "service_unavailable",
  "invalid_response",
]);

/** The review prompt asks for this exact reply when the current title still fits. */
export const KEEP_REPLY = "KEEP";

const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/giu;
const CODE_FENCE_LINE = /^```[\w-]*$/u;
const LEADING_LABEL = /^(?:thread title|title)\s*:\s*/iu;
const WRAPPING_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["**", "**"],
] as const;
// The vendored transport points users at bb's AI-services picker, which does
// not route GTD's naming.
const BB_SERVICE_HINT = /Retry, or choose another service in Settings → AI services\./u;
const GTD_SERVICE_HINT =
  "Retry, or log in to Codex with an OpenAI API key so naming requests go to api.openai.com instead.";

/**
 * Reads a plain-text reply as bb's `cleanGeneratedLine` does: the first
 * non-empty line, without a label or wrapping quotes. `null` means keep.
 */
export function readTitleReply(raw: string, allowKeep: boolean): string | null {
  const line = raw
    .replace(THINK_BLOCK, "")
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "" && !CODE_FENCE_LINE.test(candidate));
  const title = unwrap(unwrap(line ?? "").replace(LEADING_LABEL, ""));
  if (title.replace(/[.!]$/u, "").toUpperCase() === KEEP_REPLY) {
    if (allowKeep) return null;
    throw new Error("The inference service kept the title when a new name was requested.");
  }
  if (title === "") throw new Error("The inference service returned no title.");
  return title;
}

function unwrap(value: string): string {
  let current = value.trim();
  for (;;) {
    const pair = WRAPPING_PAIRS.find(
      ([open, close]) =>
        current.length >= open.length + close.length &&
        current.startsWith(open) &&
        current.endsWith(close),
    );
    if (pair === undefined) return current;
    current = current.slice(pair[0].length, -pair[1].length).trim();
  }
}

export interface ThreadTitleInference {
  complete(input: {
    environmentId: string | null;
    prompt: string;
    allowKeep: boolean;
  }): Promise<string | null>;
}

export interface TitleInferenceAttempt {
  model: string;
  attempt: number;
  elapsedMs: number;
  outcome: string;
}

interface CompleteWithFallbackInput {
  complete(model: string): Promise<GtdSidebarCodexResult>;
  onAttempt?: (attempt: TitleInferenceAttempt) => void;
}

/** Returns the reply text; throws the last failure once no model is left to try. */
export async function completeWithModelFallback({
  complete,
  onAttempt,
}: CompleteWithFallbackInput): Promise<string> {
  let last: GtdSidebarCodexResult | null = null;
  for (const [attempt, model] of TITLE_MODELS.entries()) {
    const started = performance.now();
    const report = (outcome: string) => {
      try {
        onAttempt?.({ model, attempt, outcome, elapsedMs: performance.now() - started });
      } catch {
        // Measurement must not turn a successful rename into a failure.
      }
    };
    try {
      last = await complete(model);
    } catch (error) {
      report("transport-error");
      throw error;
    }
    report(last.ok ? "success" : last.code);
    if (last.ok || !RETRY_WITH_NEXT_MODEL.has(last.code)) break;
  }
  if (last === null) throw new Error("The inference service returned no title.");
  if (last.ok) return last.text;
  throw new Error(last.message.replace(BB_SERVICE_HINT, GTD_SERVICE_HINT));
}

export function createThreadTitleInference(
  bb: BbPluginApi,
  host: Pick<GtdSidebarHostClient, "call">,
): ThreadTitleInference {
  return {
    async complete({ environmentId, prompt, allowKeep }) {
      const config = await bb.sdk.system.config();
      const hostId =
        config.primaryHostId ??
        (environmentId === null ? null : (await bb.sdk.environments.get({ environmentId })).hostId);
      if (hostId === null) {
        throw new Error("No host is available for thread title inference.");
      }

      const reply = await completeWithModelFallback({
        onAttempt: (attempt) => bb.log.info(`title inference ${JSON.stringify(attempt)}`),
        complete: (model) =>
          host.call(
            "codex.ai.complete",
            { model, prompt, timeoutMs: INFERENCE_TIMEOUT_MS },
            { hostId, timeoutMs: INFERENCE_TIMEOUT_MS + HOST_CALL_GRACE_MS },
          ),
      });
      return readTitleReply(reply, allowKeep);
    },
  };
}
