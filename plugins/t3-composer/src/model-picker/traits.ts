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

/** An on/off agent option the user can switch, such as Codex's Daybreak. */
export interface AgentSwitchTrait {
  id: string;
  label: string;
  description?: string;
}

export interface Traits {
  effort: { options: TraitOption[]; current: string | null } | null;
  speed: SpeedTrait | null;
  daybreak: AgentSwitchTrait | null;
}

export const DAYBREAK_OPTION_ID = "daybreak";

export const DEFAULT_SERVICE_TIER = "default";

/** The selected model's reasoning levels and service tiers, labelled from the provider's declarations. */
export function buildTraits(
  provider: CatalogProvider | undefined,
  model: CatalogModel | undefined,
  selection: ComposerSelection,
): Traits {
  if (!model) return { effort: null, speed: null, daybreak: null };
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

  const tiers = modelServiceTiers(provider, model);
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
    daybreak: agentSwitch(model, DAYBREAK_OPTION_ID),
  };
}

/** The model's on/off option by id, unless the model fixes its value. */
function agentSwitch(model: CatalogModel, id: string): AgentSwitchTrait | null {
  const option = model.sessionOptions?.find((candidate) => candidate.id === id);
  if (option?.type !== "boolean" || option.fixed === true) return null;
  return {
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  };
}

/**
 * BB's rule (domain `resolveServiceTierOptions`): a provider that supports service tiers offers
 * its declared tiers to every model, narrowed to the model's `supportedServiceTiers` when it
 * lists them. Claude Code declares Fast this way, with no per-model list.
 */
function modelServiceTiers(
  provider: CatalogProvider | undefined,
  model: CatalogModel,
): TraitOption[] {
  if (!provider?.capabilities?.supportsServiceTier) return [];
  const declared = (provider.serviceTiers ?? []).filter((tier) => tier.id !== DEFAULT_SERVICE_TIER);
  const supported = model.supportedServiceTiers;
  const byId = new Map((supported ?? []).map((tier) => [tier.id, tier]));
  return declared.flatMap((tier) => {
    const modelTier = byId.get(tier.id);
    if (supported !== undefined && !modelTier) return [];
    const description = modelTier?.description ?? tier.description;
    return [
      {
        id: tier.id,
        label: modelTier?.label ?? tier.label,
        ...(description ? { description } : {}),
        isDefault: false,
      },
    ];
  });
}
