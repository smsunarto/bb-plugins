import type { ComposerSelection, PluginComposerApi } from "@get-bb/plugin-sdk/app";

/** Why BB applied something other than the pick, or null when it applied it. */
export function refusedSettingMessage(
  requested: ComposerSelection,
  applied: ComposerSelection,
): string | null {
  if (requested.providerId && applied.providerId !== requested.providerId) {
    return "BB kept the current provider for this composer.";
  }
  if (requested.model && applied.model !== requested.model) {
    return "BB kept the current model for this composer.";
  }
  if (requested.reasoningLevel && applied.reasoningLevel !== requested.reasoningLevel) {
    return "This model does not support that effort.";
  }
  if (requested.serviceTier && applied.serviceTier !== requested.serviceTier) {
    return "This model does not offer that speed.";
  }
  if (requested.permissionMode && applied.permissionMode !== requested.permissionMode) {
    return "BB kept the current permission mode.";
  }
  return null;
}

/**
 * Sets this composer's pickers through BB, for every input that can: the pickers, the cycle
 * shortcuts and the `#` keywords. Never rejects: `error` says why BB refused or applied
 * something else, and `applied` is null when BB refused outright.
 */
export async function applySelection(
  composer: Pick<PluginComposerApi, "setSelection">,
  requested: ComposerSelection,
): Promise<{ applied: ComposerSelection | null; error: string | null }> {
  try {
    const applied = await composer.setSelection(requested);
    return { applied, error: refusedSettingMessage(requested, applied) };
  } catch (reason) {
    return { applied: null, error: reason instanceof Error ? reason.message : String(reason) };
  }
}
