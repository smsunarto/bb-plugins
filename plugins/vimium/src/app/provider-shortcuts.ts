import type { ComposerSelection, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export type ProviderShortcut = "provider" | "reasoning" | "speed";
type Model = Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>["models"][number];

const MODEL_PAIRS = [
  { codex: "astra", "claude-code": "fable" },
  { codex: "sol", "claude-code": "opus" },
];
const REASONING: readonly NonNullable<ComposerSelection["reasoningLevel"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
];

export function targetProvider(selection: ComposerSelection): string | null {
  if (selection.providerId === "codex") return "claude-code";
  if (selection.providerId === "claude-code") return "codex";
  return null;
}

function pairedSelection(
  selection: ComposerSelection,
  models: readonly Model[],
): ComposerSelection | null {
  const providerId = targetProvider(selection);
  if (providerId !== "codex" && providerId !== "claude-code") return null;
  const source = selection.providerId === "codex" ? "codex" : "claude-code";
  const pair = MODEL_PAIRS.find((pair) => selection.model?.toLowerCase().includes(pair[source]));
  const family = pair?.[providerId];
  const model =
    (family && models.find((model) => model.id.toLowerCase().includes(family))) ||
    models.find((model) => model.isDefault) ||
    models[0];
  if (!model) return null;
  return {
    providerId,
    model: model.id,
    reasoningLevel: selection.reasoningLevel,
    serviceTier: selection.serviceTier ?? "default",
  };
}

/** Resolve only against models offered by the selected checkout's provider. */
export function shortcutSelection(
  action: ProviderShortcut,
  selection: ComposerSelection,
  models: readonly Model[],
): ComposerSelection | null {
  if (action === "provider") return pairedSelection(selection, models);
  const model = models.find(
    (model) => model.id === selection.model || model.model === selection.model,
  );
  if (!model) return null;
  if (action === "reasoning") {
    const levels = model.supportedReasoningEfforts.flatMap(({ reasoningEffort }) => {
      const level = REASONING.find((level) => level === reasoningEffort);
      return level ? [level] : [];
    });
    const next =
      levels[(levels.findIndex((level) => level === selection.reasoningLevel) + 1) % levels.length];
    return next ? { reasoningLevel: next } : null;
  }
  const tiers = [
    "default",
    ...["fast", "ultrafast"].filter((id) =>
      model.supportedServiceTiers?.some((tier) => tier.id === id),
    ),
  ];
  if (tiers.length === 1) return null;
  const next = tiers[(tiers.indexOf(selection.serviceTier ?? "default") + 1) % tiers.length];
  return next ? { serviceTier: next } : null;
}

let runShortcut: ((action: ProviderShortcut) => boolean) | null = null;
export function setProviderShortcuts(run: typeof runShortcut): void {
  runShortcut = run;
}
export function runProviderShortcut(action: ProviderShortcut): boolean {
  return runShortcut?.(action) ?? false;
}
