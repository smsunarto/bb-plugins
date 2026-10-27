// Reasoning effort levels, shared by the router, the server, and the settings UI.

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/**
 * What Magic Compose may pick until the user says otherwise. `ultra` and `ultracode`
 * are special run modes that cost far more than a reasoning level, so they
 * are opt-in.
 */
export const DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Provider catalogs may advertise efforts outside this router's choices. */
export function parseReasoningLevel(value: string): ReasoningLevel | null {
  return REASONING_LEVELS.find((level) => level === value) ?? null;
}
