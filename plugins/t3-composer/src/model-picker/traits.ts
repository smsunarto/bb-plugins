import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import type { CatalogModel, CatalogProvider } from "./catalog";

export interface TraitOption {
  id: string;
  label: string;
  description?: string;
  isDefault: boolean;
}

export type SpeedTrait =
  /** One extra tier: T3 Code's "Fast mode" on/off. */
  | { kind: "toggle"; tier: TraitOption; current: string }
  /** Several tiers: a "Speed" choice starting at Normal. */
  | { kind: "select"; options: TraitOption[]; current: string };

export interface Traits {
  effort: { options: TraitOption[]; current: string | null } | null;
  speed: SpeedTrait | null;
}

export const DEFAULT_SERVICE_TIER = "default";

/** The selected model's reasoning levels and service tiers, labelled from the provider's declarations. */
export function buildTraits(
  provider: CatalogProvider | undefined,
  model: CatalogModel | undefined,
  selection: ComposerSelection,
): Traits {
  if (!model) return { effort: null, speed: null };
  const levelLabels = new Map((provider?.reasoningLevels ?? []).map((level) => [level.id, level]));
  const effortOptions = model.supportedReasoningEfforts.map((effort) => {
    const declared = levelLabels.get(effort.reasoningEffort);
    return {
      id: effort.reasoningEffort,
      label: effort.label ?? declared?.label ?? effort.reasoningEffort,
      description: effort.description || declared?.description,
      isDefault: effort.reasoningEffort === model.defaultReasoningEffort,
    };
  });

  const tierLabels = new Map((provider?.serviceTiers ?? []).map((tier) => [tier.id, tier]));
  const tiers = (model.supportedServiceTiers ?? [])
    .filter((tier) => tier.id !== DEFAULT_SERVICE_TIER)
    .map((tier) => ({
      id: tier.id,
      label: tier.label ?? tierLabels.get(tier.id)?.label ?? tier.id,
      description: tier.description ?? tierLabels.get(tier.id)?.description,
      isDefault: false,
    }));
  const currentTier = selection.serviceTier ?? DEFAULT_SERVICE_TIER;
  const speed: SpeedTrait | null =
    tiers.length === 0
      ? null
      : tiers.length === 1
        ? { kind: "toggle", tier: tiers[0]!, current: currentTier }
        : {
            kind: "select",
            options: [{ id: DEFAULT_SERVICE_TIER, label: "Normal", isDefault: true }, ...tiers],
            current: currentTier,
          };

  return {
    effort:
      effortOptions.length > 1
        ? { options: effortOptions, current: selection.reasoningLevel ?? null }
        : null,
    speed,
  };
}

/** "Fast" or "Ultrafast" while a faster tier is chosen, for the trigger's bolt. */
export function speedLabel(speed: SpeedTrait | null): "Fast" | "Ultrafast" | null {
  if (!speed || speed.current === DEFAULT_SERVICE_TIER) return null;
  return speed.current === "ultrafast" ? "Ultrafast" : "Fast";
}
