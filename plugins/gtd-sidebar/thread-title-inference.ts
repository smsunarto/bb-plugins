import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  gtdSidebarHostContract,
  type GtdSidebarAiInferenceCompleteOutput,
} from "./lib/host-contract.ts";

const TITLE_PRIMARY_MODEL = "gpt-5.6-luna";
const TITLE_FALLBACK_MODEL = "gpt-5.4-mini";
const INFERENCE_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 250;
const TRANSIENT_FAILURES = new Set(["timeout", "rate_limited", "service_unavailable"]);

export const TITLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["keep", "rename"] },
    title: { type: "string" },
  },
  required: ["action", "title"],
  additionalProperties: false,
};

export function formatInferredTitle(value: Record<string, unknown>): string | null {
  const { action, title } = value;
  if ((action !== "keep" && action !== "rename") || typeof title !== "string") {
    throw new Error("The inference service returned an invalid title.");
  }
  if (action === "keep") return null;
  if (!title.trim()) throw new Error("The inference service returned no title.");
  return title.trim();
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
  primary: string;
  fallback: string;
  complete(model: string): Promise<GtdSidebarAiInferenceCompleteOutput>;
  sleep?: (durationMs: number) => Promise<void>;
  onAttempt?: (attempt: TitleInferenceAttempt) => void;
}

export async function completeThreadTitleWithFallback({
  complete,
  fallback,
  primary,
  sleep = wait,
  onAttempt,
}: CompleteWithFallbackInput): Promise<string | null> {
  const models = [primary, fallback] as const;

  for (const [attempt, model] of models.entries()) {
    const started = performance.now();
    const report = (outcome: string) => {
      try {
        onAttempt?.({ model, attempt, outcome, elapsedMs: performance.now() - started });
      } catch {
        // Measurement must not turn a successful rename into a failure.
      }
    };
    let result: GtdSidebarAiInferenceCompleteOutput;
    try {
      result = await complete(model);
    } catch (error) {
      report("transport-error");
      throw error;
    }
    report(result.ok ? "success" : result.code);
    if (result.ok) {
      return formatInferredTitle(result.value);
    }

    const canRetry = attempt === 0 && TRANSIENT_FAILURES.has(result.code);
    if (!canRetry) throw new Error(result.message);
    await sleep(RETRY_DELAY_MS);
  }

  throw new Error("The inference service returned no title.");
}

export function createThreadTitleInference(bb: BbPluginApi): ThreadTitleInference {
  const host = bb.hosts.experimental_client({ contract: gtdSidebarHostContract });

  return {
    async complete({ environmentId, prompt, allowKeep }) {
      const config = await bb.sdk.system.config();
      const hostId =
        config.primaryHostId ??
        (environmentId === null ? null : (await bb.sdk.environments.get({ environmentId })).hostId);
      if (hostId === null) {
        throw new Error("No host is available for thread title inference.");
      }

      return completeThreadTitleWithFallback({
        primary: TITLE_PRIMARY_MODEL,
        fallback: TITLE_FALLBACK_MODEL,
        onAttempt: (attempt) => bb.log.info(`title inference ${JSON.stringify(attempt)}`),
        complete: (model) =>
          host.call(
            "ai.inference.complete",
            {
              model,
              prompt,
              outputSchema: {
                ...TITLE_OUTPUT_SCHEMA,
                properties: {
                  ...TITLE_OUTPUT_SCHEMA.properties,
                  action: { type: "string", enum: allowKeep ? ["keep", "rename"] : ["rename"] },
                },
              },
              timeoutMs: INFERENCE_TIMEOUT_MS,
            },
            { hostId },
          ),
      });
    },
  };
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
