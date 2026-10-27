// What the composer is asked to select for a routing decision. The composer has
// the last word: it lowers a permission mode above the machine's limit, moves a
// reasoning level the model lacks to the nearest one it has, and so on, and its
// pickers show what it settled on.
import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import type { DecisionSummary } from "../server";
import type { MaySet } from "./preferences";
import { REASONING_LEVELS } from "./reasoning";

/**
 * The composer selection that carries out `decision`, leaving out the pickers
 * Magic Compose has been told not to set. Permission mode is always left to the user.
 */
export function selectionFor(decision: DecisionSummary, sets: MaySet): ComposerSelection {
  // A reasoning pick is labelled with its level.
  const reasoningLevel = REASONING_LEVELS.find((level) => level === decision.reasoning.label);
  if (reasoningLevel === undefined) {
    throw new Error(`Jev picked an unknown reasoning level, “${decision.reasoning.label}”.`);
  }
  return {
    ...(sets.project ? { projectId: decision.project.id } : {}),
    ...(sets.placement
      ? {
          environment: {
            type: "provider" as const,
            environmentProviderId: decision.environment.id,
            // Not applied: the composer keeps its own inputs, such as the branch to start from.
            inputs: {},
            machine: { type: "existing" as const, hostId: decision.machine.id },
          },
        }
      : {}),
    ...(sets.model
      ? {
          providerId: decision.model.providerId,
          model: decision.model.model,
          // Jev chose this effort for this model, so it goes only where the model does.
          ...(sets.effort ? { reasoningLevel } : {}),
        }
      : {}),
  };
}

function placement(selection: ComposerSelection): string {
  const environment = selection.environment;
  if (environment?.type !== "provider") return JSON.stringify(environment ?? null);
  const machine = environment.machine?.type === "existing" ? environment.machine.hostId : "";
  return `${selection.projectId ?? ""} ${environment.environmentProviderId} on ${machine}`;
}

/**
 * What to set now that Jev's answer has gone from `previous` to `next`: only
 * what changed, so a picker changed by hand stays as it was left until Jev's
 * answer for it changes. Empty when there is nothing to set.
 */
export function changedSelection(
  previous: ComposerSelection | null,
  next: ComposerSelection,
): ComposerSelection {
  // A move sets everything again: BB remembers the environment per project,
  // and each machine has its own model catalog to reconcile against.
  if (previous === null || placement(previous) !== placement(next)) return next;
  const sameModel =
    previous.providerId === next.providerId &&
    previous.model === next.model &&
    previous.reasoningLevel === next.reasoningLevel;
  if (sameModel) return {};
  // Effort is chosen per model, so the three travel together.
  return {
    ...(next.providerId === undefined ? {} : { providerId: next.providerId }),
    ...(next.model === undefined ? {} : { model: next.model }),
    ...(next.reasoningLevel === undefined ? {} : { reasoningLevel: next.reasoningLevel }),
  };
}
