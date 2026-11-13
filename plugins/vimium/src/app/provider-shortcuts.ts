import type { ComposerSelection, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export type ProviderShortcut =
  | "provider"
  | "model"
  | "reasoning"
  | "reasoning-up"
  | "reasoning-down"
  | "speed";
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

export interface Favorite {
  readonly providerId: string;
  readonly model: string;
}

// t3-composer keeps favorite models per device, as `providerId\0model` in the
// order they were starred. The SDK has no favorites, so read its list.
const FAVORITES_KEY = "bb-plugin:t3-composer:model-favorites";

export function readFavorites(storage: Pick<Storage, "getItem"> | undefined): Favorite[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(FAVORITES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((key) => {
      if (typeof key !== "string") return [];
      const split = key.indexOf("\0");
      if (split <= 0 || split === key.length - 1) return [];
      return [{ providerId: key.slice(0, split), model: key.slice(split + 1) }];
    });
  } catch {
    return [];
  }
}

const sameModel = (model: Model, name: string | undefined) =>
  name !== undefined && (model.id === name || model.model === name);

/**
 * The provider a provider switch lands on: the next provider with a favorite,
 * in the order their first favorite was starred, wrapping. With favorites in
 * fewer than two providers, Codex and Claude Code swap.
 */
export function targetProvider(
  selection: ComposerSelection,
  favorites: readonly Favorite[] = [],
): string | null {
  const providers = [...new Set(favorites.map((favorite) => favorite.providerId))];
  const current = selection.providerId ?? "";
  const others = providers.filter((providerId) => providerId !== current);
  if (others.length > 0) {
    const index = providers.indexOf(current);
    return index === -1 ? others[0]! : providers[(index + 1) % providers.length]!;
  }
  if (current === "codex") return "claude-code";
  if (current === "claude-code") return "codex";
  return null;
}

/** The model family on `providerId` the same size as `model`, from MODEL_PAIRS. */
function pairedFamily(model: string | undefined, providerId: string): string | undefined {
  const name = model?.toLowerCase() ?? "";
  const pair = MODEL_PAIRS.find((pair) =>
    Object.values(pair).some((family) => name.includes(family)),
  );
  return pair?.[providerId as keyof typeof pair];
}

function pairedSelection(
  selection: ComposerSelection,
  models: readonly Model[],
  favorites: readonly Favorite[],
): ComposerSelection | null {
  const providerId = targetProvider(selection, favorites);
  if (!providerId) return null;
  const family = pairedFamily(selection.model, providerId);
  const ofFamily = (model: Model) =>
    family !== undefined && model.id.toLowerCase().includes(family);
  const starred = favorites.flatMap((favorite) => {
    if (favorite.providerId !== providerId) return [];
    const model = models.find((model) => sameModel(model, favorite.model));
    return model ? [model] : [];
  });
  // Same size first, a favorite before any other model of that size.
  const model =
    starred.find(ofFamily) ||
    models.find(ofFamily) ||
    starred[0] ||
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
  favorites: readonly Favorite[] = [],
): ComposerSelection | null {
  if (action === "provider") return pairedSelection(selection, models, favorites);
  if (action === "model") return nextFavoriteModel(selection, models, favorites);
  const model = models.find((model) => sameModel(model, selection.model));
  if (!model) return null;
  if (action === "reasoning-up" || action === "reasoning-down") {
    return steppedReasoning(model, selection.reasoningLevel, action === "reasoning-up" ? 1 : -1);
  }
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

/** One reasoning level up or down; stops at the ends, unlike the wrapping cycle. */
function steppedReasoning(
  model: Model,
  reasoningLevel: ComposerSelection["reasoningLevel"],
  step: 1 | -1,
): ComposerSelection | null {
  const levels = REASONING.filter((level) =>
    model.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === level),
  );
  const current = levels.indexOf(
    (reasoningLevel ?? model.defaultReasoningEffort) as (typeof REASONING)[number],
  );
  const next = levels[current + step];
  return current === -1 || !next ? null : { reasoningLevel: next };
}

/** The next starred model on the current provider, wrapping; the first one when off the list. */
function nextFavoriteModel(
  selection: ComposerSelection,
  models: readonly Model[],
  favorites: readonly Favorite[],
): ComposerSelection | null {
  const starred = favorites.flatMap((favorite) => {
    if (favorite.providerId !== selection.providerId) return [];
    const model = models.find((model) => sameModel(model, favorite.model));
    return model ? [model] : [];
  });
  const current = starred.findIndex((model) => sameModel(model, selection.model));
  const next = starred[(current + 1) % starred.length];
  return next && !sameModel(next, selection.model) ? { model: next.id } : null;
}

let runShortcut: ((action: ProviderShortcut) => boolean) | null = null;
export function setProviderShortcuts(run: typeof runShortcut): void {
  runShortcut = run;
}
export function runProviderShortcut(action: ProviderShortcut): boolean {
  return runShortcut?.(action) ?? false;
}
