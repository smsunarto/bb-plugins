import { useRef, useState, type ReactNode } from "react";
import {
  useComposer,
  type ComposerSelection,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { isAnchorInteractive } from "@/components/ui/overlay-anchor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { findCatalogModel, useModelCatalog, type CatalogModel } from "./catalog";
import { ModelPicker } from "./ModelPicker";
import { TraitsPicker } from "./TraitsPicker";
import { buildTraits } from "./traits";
import "./model-picker.css";

/**
 * Whether `setSelection` can change this composer's pickers. Queued-message and
 * sent-message editors report a selection but show it read-only; BB marks a
 * sent-message editor only through its per-session key.
 */
export function hasEditablePickers(composer: PluginComposerApi) {
  return (
    composer.selection !== null &&
    composer.scope.kind !== "queued-message" &&
    !composer.key.startsWith("sent-message:")
  );
}

function ignoredPickMessage(requested: ComposerSelection, applied: ComposerSelection) {
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
  return null;
}

/**
 * Whether the model has an agent option only BB's picker can set: a list to choose from. An
 * on/off option, such as Codex's Daybreak, keeps BB's value (off unless turned on there), so
 * it need not cost the composer these pickers, here or in a new thread.
 */
function needsBbPicker(model: CatalogModel) {
  return model.sessionOptions?.some((option) => option.type === "select") ?? false;
}

/**
 * T3 Code's model and traits pickers over BB's composer selection. Picks go
 * through `setSelection`, the same path as BB's picker, so a provider switch
 * in a thread starts BB's handoff. `fallback` is BB's own control: shown where
 * this composer's pickers are read-only, until the selected model's catalog
 * entry is known, and for models with an agent option to choose from, which
 * `setSelection` cannot set.
 */
export function ComposerModelControls(props: { fallback: ReactNode }) {
  const composer = useComposer();
  const editable = hasEditablePickers(composer);
  const catalog = useModelCatalog(composer, editable && props.fallback != null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestPick = useRef(0);
  const controlsRef = useRef<HTMLDivElement>(null);
  const selection = composer.selection;
  if (!props.fallback || !editable || !selection?.providerId) return props.fallback;

  const provider = catalog.providers.find((candidate) => candidate.id === selection.providerId);
  const model = findCatalogModel(catalog.catalogFor(selection.providerId).models, selection.model);
  if (!model || needsBbPicker(model)) return props.fallback;
  const traits = buildTraits(provider, model, selection);

  /** Settles once BB has applied or refused the pick, so the effort slider can let go of it. */
  const apply = (requested: ComposerSelection): Promise<unknown> => {
    const pick = ++latestPick.current;
    // BB disables its own picker while the agent waits on a question or approval and hides the
    // composer to show it; the SDK has no flag for that, so a hidden composer takes no picks.
    if (controlsRef.current && !isAnchorInteractive(controlsRef.current)) {
      setError("Answer the agent's question first.");
      return Promise.resolve();
    }
    setPending(true);
    setError(null);
    return composer
      .setSelection(requested)
      .then((applied) => {
        if (pick === latestPick.current) setError(ignoredPickMessage(requested, applied));
        return applied;
      })
      .catch((reason: unknown) => {
        if (pick === latestPick.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (pick === latestPick.current) setPending(false);
      });
  };

  return (
    <TooltipProvider>
      <div
        ref={controlsRef}
        data-t3-model-controls=""
        data-pending={pending ? "" : undefined}
        className="contents"
      >
        <ModelPicker
          catalog={catalog}
          providerId={selection.providerId}
          model={selection.model}
          speed={traits.speed}
          onSelect={(providerId, nextModel) => void apply({ providerId, model: nextModel })}
          onSpeedChange={(serviceTier) => void apply({ serviceTier })}
        />
        <TraitsPicker
          effort={traits.effort}
          onEffortChange={(reasoningLevel) => apply({ reasoningLevel })}
        />
        {error ? (
          <span
            role="alert"
            className="ml-1 max-w-48 truncate text-xs text-destructive"
            title={error}
          >
            {error}
          </span>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
