import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  GTD_SIDEBAR_AI_SERVICE_ID,
  gtdSidebarHostContract,
  type GtdSidebarAiInferenceCompleteOutput,
  type InferenceUsage,
} from "./lib/host-contract.ts";

const TITLE_PRIMARY_MODEL = "gpt-5.6-luna";
const TITLE_FALLBACK_MODEL = "gpt-5.4-mini";
const TITLE_REASONING_EFFORT = "none";
const INFERENCE_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 250;
const TRANSIENT_FAILURES = new Set(["timeout", "rate_limited", "service_unavailable"]);

const ACTIVITIES: Record<string, string> = {
  explore: "",
  plan: "📝",
  build: "🛠️",
  fix: "🐛",
  verify: "🧪",
  install: "📦",
  configure: "⚙️",
  refactor: "♻️",
  review: "🔎",
  ready: "🚀",
  shipped: "☑️",
};

export const TITLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    activity: { type: "string", enum: Object.keys(ACTIVITIES) },
    scope: { type: "string" },
    title: { type: "string" },
  },
  required: ["activity", "scope", "title"],
  additionalProperties: false,
};

export function formatInferredTitle(value: Record<string, unknown>): string {
  const { activity, scope, title } = value;
  if (
    typeof activity !== "string" ||
    !Object.hasOwn(ACTIVITIES, activity) ||
    typeof scope !== "string" ||
    typeof title !== "string"
  ) {
    throw new Error("The inference service returned an invalid title.");
  }
  const cleanScope = scope.replace(/[[\]\r\n]/gu, "").trim();
  const taskTitle = title.trim().replace(/^\[([^\]]+)\]\s*/u, (prefix, label: string) =>
    [cleanScope, ...cleanScope.split("+")].some(
      (part) =>
        part
          .trim()
          .replace(/\s+plugin$/iu, "")
          .toLowerCase() === label.trim().toLowerCase(),
    )
      ? ""
      : prefix,
  );
  if (!taskTitle) throw new Error("The inference service returned no title.");
  const task =
    activity === "explore"
      ? taskTitle
      : taskTitle.replace(
          /^(?:continue\s+)?(?:write|review|fix|implement|install|configure|verify|refactor|build|push)\b\s*|^continue\s+/iu,
          "",
        );
  if (!task) throw new Error("The inference service returned no task.");
  const subject = task.charAt(0).toUpperCase() + task.slice(1);
  return [ACTIVITIES[activity], cleanScope ? `[${cleanScope}]` : "", subject]
    .filter(Boolean)
    .join(" ");
}

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
  onAttempt?: (attempt: TitleInferenceAttempt) => void;
  format?: (value: Record<string, unknown>) => string;
}

export interface TitleInferenceAttempt {
  model: string;
  attempt: number;
  elapsedMs: number;
  outcome: string;
  usage?: InferenceUsage;
}

export async function completeThreadTitleWithFallback({
  complete,
  fallback,
  primary,
  sleep = wait,
  onAttempt,
  format = formatInferredTitle,
}: CompleteWithFallbackInput): Promise<string> {
  const models = [primary, fallback] as const;

  for (const [attempt, model] of models.entries()) {
    const started = performance.now();
    const report = (outcome: string, usage?: InferenceUsage) => {
      try {
        onAttempt?.({
          model,
          attempt,
          outcome,
          elapsedMs: performance.now() - started,
          ...(usage === undefined ? {} : { usage }),
        });
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
    report(result.ok ? "success" : result.code, result.ok ? result.usage : undefined);
    if (result.ok) {
      return format(result.value);
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
        onAttempt: (attempt) =>
          bb.log.info(
            `title inference ${JSON.stringify({
              ...attempt,
              reasoningEffort: TITLE_REASONING_EFFORT,
            })}`,
          ),
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
