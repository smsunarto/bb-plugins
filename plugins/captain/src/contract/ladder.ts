/**
 * A role's model ladder: the provider, model and reasoning each crew thread of
 * that role starts on, in fallback order. Rung 1 is tried first; dispatch takes
 * the first rung whose provider has an eligible account, and a crew thread that
 * fails on a rate limit restarts on the next one. Shared by the server and the
 * settings section.
 */
import { z } from "zod";

/** The roles Captain dispatches through Tasks, each with its own ladder. */
export const LADDER_ROLES = ["implement", "review"] as const;
export type LadderRole = (typeof LADDER_ROLES)[number];

/** More rungs than this is a mistake, not a fallback plan. */
export const MAX_RUNGS = 6;

const nonBlank = z.string().trim().min(1).max(200);

export const rungSchema = z
  .object({
    providerId: nonBlank,
    model: nonBlank,
    reasoningLevel: nonBlank,
    /** A tier the provider declares; absent when the provider has none. */
    serviceTier: nonBlank.optional(),
  })
  .strict();
export type Rung = z.infer<typeof rungSchema>;

export const ladderSchema = z.array(rungSchema).min(1).max(MAX_RUNGS);

/** One rung as a person reads it: `codex gpt-6-astra high`. */
export function rungLabel(rung: Rung): string {
  return [rung.providerId, rung.model, rung.reasoningLevel, rung.serviceTier]
    .filter((part) => part !== undefined)
    .join(" ");
}
