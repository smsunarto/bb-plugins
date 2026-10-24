import type { ComposerSelection, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import type { AgentSelection } from "../shared/generation.ts";
import { REQUEST_MENTION_PROVIDER } from "../shared/request-mention.ts";

/**
 * Add a prepared request to the end of the draft on its own paragraph, with the request pill
 * after its prompt, and focus the composer so the person can review and send it.
 */
export function appendStudioRequest(
  composer: Pick<PluginComposerApi, "insert" | "focus">,
  prompt: string,
  mention: { id: string; label: string },
) {
  composer.insert([prompt, " ", { provider: REQUEST_MENTION_PROVIDER, ...mention }, " "], {
    at: "end",
    block: true,
  });
  composer.focus();
}

/** The composer's picked agent, or undefined while no provider and model are picked. */
export function selectedAgent(
  selection: ComposerSelection | null,
  fallbackReasoningLevel: string,
): AgentSelection | undefined {
  if (!selection?.providerId || !selection.model) return undefined;
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: selection.reasoningLevel ?? fallbackReasoningLevel,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
  };
}
