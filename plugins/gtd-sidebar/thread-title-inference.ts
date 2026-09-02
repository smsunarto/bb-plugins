import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  GTD_SIDEBAR_AI_SERVICE_ID,
  gtdSidebarHostContract,
  type GtdSidebarAiInferenceCompleteOutput,
} from "./lib/host-contract.ts";

const TITLE_PRIMARY_MODEL = "gpt-5.6-luna";
const TITLE_FALLBACK_MODEL = "gpt-5.4-mini";
const TITLE_REASONING_EFFORT = "low";
const INFERENCE_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 250;
const TRANSIENT_FAILURES = new Set(["timeout", "rate_limited", "service_unavailable"]);

const TITLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

export interface ThreadTitleInference {
  complete(input: { environmentId: string | null; prompt: string }): Promise<string>;
}

interface InferenceModels {
  primary: string;
  fallback: string;
}

interface CompleteWithFallbackInput extends InferenceModels {
  complete(model: string): Promise<GtdSidebarAiInferenceCompleteOutput>;
  sleep?: (durationMs: number) => Promise<void>;
}

export async function completeThreadTitleWithFallback({
  complete,
  fallback,
  primary,
  sleep = wait,
}: CompleteWithFallbackInput): Promise<string> {
  const models = [primary, fallback] as const;

  for (const [attempt, model] of models.entries()) {
    const result = await complete(model);
    if (result.ok) {
      const title = result.value.title;
      if (typeof title !== "string") {
        throw new Error("The inference service returned no title.");
      }
      return title;
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
    async complete({ environmentId, prompt }) {
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
        complete: (model) =>
          host.call(
            "ai.inference.complete",
            {
              serviceId: GTD_SIDEBAR_AI_SERVICE_ID,
              model,
              reasoningEffort: TITLE_REASONING_EFFORT,
              prompt,
              outputSchema: TITLE_OUTPUT_SCHEMA,
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
