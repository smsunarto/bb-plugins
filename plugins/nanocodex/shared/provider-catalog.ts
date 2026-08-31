import type { Model, Thinking } from "nanocodex/host";

export const NANOCODEX_PROVIDER_ID = "nanocodex";
export const NANOCODEX_BINDING_VERSION = "0.0.0-preview-fa3f254";
export const NANOCODEX_CONTEXT_WINDOW_TOKENS = 272_000;

export const NANOCODEX_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly Thinking[];

export type NanocodexReasoningLevel = (typeof NANOCODEX_REASONING_LEVELS)[number];

const FULL_REASONING_LADDER = NANOCODEX_REASONING_LEVELS.map((reasoningEffort) => ({
  reasoningEffort,
  description: reasoningEffort,
}));

export const NANOCODEX_MODELS = [
  {
    id: "gpt-5.6-sol",
    displayName: "Sol",
    description: "The default NanoCodex model.",
    supportedReasoningEfforts: FULL_REASONING_LADDER,
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "gpt-5.6-terra",
    displayName: "Terra",
    description: "The balanced NanoCodex model.",
    supportedReasoningEfforts: FULL_REASONING_LADDER,
    defaultReasoningEffort: "high",
    isDefault: false,
  },
  {
    id: "gpt-5.6-luna",
    displayName: "Luna",
    description: "The fast NanoCodex model.",
    supportedReasoningEfforts: FULL_REASONING_LADDER,
    defaultReasoningEffort: "high",
    isDefault: false,
  },
] as const;

export const NANOCODEX_SERVICE_TIERS = [
  { id: "default", label: "Standard" },
  { id: "fast", label: "Fast", description: "Priority processing" },
] as const;

export const NANOCODEX_WIRE_MODELS = NANOCODEX_MODELS.map((model) => ({
  ...model,
  model: model.id,
}));

export function isNanocodexModel(value: string | undefined): value is Model {
  return NANOCODEX_MODELS.some((model) => model.id === value);
}

export function isNanocodexThinking(value: string | undefined): value is Thinking {
  return NANOCODEX_REASONING_LEVELS.some((thinking) => thinking === value);
}
