import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type ComposerSelection, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { usePickerComposer } from "../composer-handle";
import { isAnchorInteractive } from "@/components/ui/overlay-anchor";
import { applySelection } from "../composer-settings/apply-selection";
import { TooltipProvider } from "@/components/ui/tooltip";
import { findCatalogModel, useModelCatalog, type CatalogModel } from "./catalog";
import { ModelPicker } from "./ModelPicker";
import { TraitsPicker } from "./TraitsPicker";
import {
  currentPlatform,
  cycleValue,
  matchModelShortcut,
  modelShortcutBindings,
  useKeybindings,
} from "./model-shortcuts";
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

/** Matches core's `SessionOptionsMenu` (`splitSessionOptionsByPlacement`): mode options live in the footer. */
const SESSION_OPTION_MODE_CATEGORY = "mode";

/**
 * Whether the model has a picker-hosted agent option only BB's picker can set: a list option
 * whose category is not `"mode"`. BB renders `"mode"` options (such as ACP's Mode) in its footer
 * "Agent options" menu rather than its model picker, so they stay usable there without handing
 * the model selector back to BB. An on/off option, such as Codex's Daybreak, keeps BB's value
 * (off unless turned on there), so it need not cost the composer these pickers either.
 */
function needsBbPicker(model: CatalogModel) {
  return (
    model.sessionOptions?.some(
      (option) => option.type === "select" && option.category !== SESSION_OPTION_MODE_CATEGORY,
    ) ?? false
  );
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
  const hasFallback = Boolean(props.fallback);
  // Keep the same element while typing. React 19.2 keeps useEffectEvent callbacks at their
  // first render inside a memo component.
  const controls = useMemo(() => <ModelControls hasFallback={hasFallback} />, [hasFallback]);
  return (
    <HostControlContext.Provider value={props.fallback}>{controls}</HostControlContext.Provider>
  );
}

/**
 * BB's own control, read from context instead of a prop: the host hands over a new node on
 * every render, and as a prop it would re-render the pickers on every keystroke.
 */
const HostControlContext = createContext<ReactNode>(null);

function HostControl() {
  return useContext(HostControlContext);
}

function ModelControls(props: { hasFallback: boolean }) {
  const composer = usePickerComposer();
  const editable = hasEditablePickers(composer);
  const catalog = useModelCatalog(composer, editable && props.hasFallback);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestPick = useRef(0);
  const controlsRef = useRef<HTMLDivElement>(null);
  const selection = composer.selection;
  const providerId = props.hasFallback && editable ? selection?.providerId : undefined;
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  const models = providerId ? catalog.catalogFor(providerId).models : [];
  const model = findCatalogModel(models, selection?.model);
  const ownPickers = providerId !== undefined && model !== undefined && !needsBbPicker(model);
  const keybindings = useKeybindings(ownPickers);
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
    return applySelection(composer, requested).then(({ applied, error }) => {
      if (pick === latestPick.current) {
        setError(error);
        setPending(false);
      }
      return applied;
    });
  };

  // BB's own picker handles its cycle shortcuts; where these pickers replace it, they do.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!ownPickers || !selection || event.isComposing || event.defaultPrevented) return;
    const platform = currentPlatform();
    const command = matchModelShortcut(
      event,
      modelShortcutBindings(keybindings, platform),
      platform,
    );
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    const backward = command.endsWith("Backward");
    if (command.startsWith("modelPicker.cycleModel")) {
      const next = cycleValue(
        models.map((candidate) => candidate.model),
        model.model,
        backward,
      );
      if (next) void apply({ providerId, model: next });
    } else if (command.startsWith("modelPicker.cycleProvider")) {
      const next = cycleValue(
        catalog.providers
          .filter((candidate) => candidate.available)
          .map((candidate) => candidate.id),
        providerId,
        backward,
      );
      if (!next) return;
      // Without the provider's models yet, BB picks its default model.
      const nextModel = catalog.catalogFor(next).models.find((candidate) => candidate.isDefault);
      void apply(nextModel ? { providerId: next, model: nextModel.model } : { providerId: next });
    } else {
      const effort = buildTraits(provider, model, selection).effort;
      if (!effort) return;
      const next = cycleValue(
        effort.options.map((option) => option.id),
        effort.current ?? model.defaultReasoningEffort,
        backward,
      );
      if (next) void apply({ reasoningLevel: next });
    }
  });
  useEffect(() => {
    // Keys pressed anywhere in this composer, before its editor sees them.
    const root = controlsRef.current?.closest<HTMLElement>("[data-t3-composer]");
    if (!ownPickers || !root) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    root.addEventListener("keydown", listener, true);
    return () => root.removeEventListener("keydown", listener, true);
  }, [ownPickers]);

  const errorNote = error ? (
    <span role="alert" className="ml-1 max-w-48 truncate text-xs text-destructive" title={error}>
      {error}
    </span>
  ) : null;

  if (!providerId || !selection || !model || !ownPickers) {
    return (
      <>
        <HostControl />
        {errorNote}
      </>
    );
  }
  const traits = buildTraits(provider, model, selection);

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
          onSelect={(providerId, nextModel) => void apply({ providerId, model: nextModel })}
        />
        <TraitsPicker
          effort={traits.effort}
          speed={traits.speed}
          daybreak={traits.daybreak}
          bbPicker={traits.daybreak && !traits.daybreak.fixed ? <HostControl /> : null}
          switchKey={`${composer.key}|${selection.providerId}|${selection.model ?? ""}`}
          onEffortChange={(reasoningLevel) => apply({ reasoningLevel })}
          onSpeedChange={(serviceTier) => void apply({ serviceTier })}
          onError={setError}
        />
        {errorNote}
      </div>
    </TooltipProvider>
  );
}
