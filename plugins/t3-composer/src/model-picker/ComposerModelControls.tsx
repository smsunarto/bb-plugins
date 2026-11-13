import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  useComposer,
  type ComposerSelection,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { isAnchorInteractive } from "@/components/ui/overlay-anchor";
import { refusedSettingMessage } from "../composer-settings/setting-keywords";
import { TooltipProvider } from "@/components/ui/tooltip";
import { findCatalogModel, useModelCatalog, type CatalogModel } from "./catalog";
import { ModelPicker } from "./ModelPicker";
import { TraitsPicker } from "./TraitsPicker";
import { BbSwitchMissing, startBbHandoff } from "./bb-picker-driver";
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
 *
 * `handoffRef` receives a function that starts BB's handoff to a new thread through BB's
 * picker, for `/handoff`. It resolves true once the handoff has started, and otherwise shows
 * why beside the pickers.
 */
export function ComposerModelControls(props: {
  fallback: ReactNode;
  handoffRef?: { current: (() => Promise<boolean>) | null };
}) {
  const composer = useComposer();
  const editable = hasEditablePickers(composer);
  const catalog = useModelCatalog(composer, editable && props.fallback != null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestPick = useRef(0);
  const controlsRef = useRef<HTMLDivElement>(null);
  const selection = composer.selection;
  const providerId = props.fallback && editable ? selection?.providerId : undefined;
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  const models = providerId ? catalog.catalogFor(providerId).models : [];
  const model = findCatalogModel(models, selection?.model);
  const ownPickers = providerId !== undefined && model !== undefined && !needsBbPicker(model);
  const keybindings = useKeybindings(ownPickers);
  const {
    driving: handoffDriving,
    attachHost: attachHandoffHost,
    start: startHandoff,
  } = useHandoffDriver(controlsRef, setError);
  useEffect(() => {
    const ref = props.handoffRef;
    if (!ref) return;
    ref.current = startHandoff;
    return () => {
      if (ref.current === startHandoff) ref.current = null;
    };
  }, [props.handoffRef, startHandoff]);

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
        if (pick === latestPick.current) setError(refusedSettingMessage(requested, applied));
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
    // BB's picker in place of these: the handoff drives it where it stands.
    return (
      <>
        <span ref={attachHandoffHost} className="contents">
          {props.fallback}
        </span>
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
          bbPicker={traits.daybreak ? props.fallback : null}
          switchKey={`${composer.key}|${selection.providerId}|${selection.model ?? ""}`}
          onEffortChange={(reasoningLevel) => apply({ reasoningLevel })}
          onSpeedChange={(serviceTier) => void apply({ serviceTier })}
          onError={setError}
        />
        {/* Out of sight and inert, only while a handoff drives it; see bb-picker-driver.ts. */}
        {handoffDriving ? (
          <span ref={attachHandoffHost} data-t3-bb-picker-host="" aria-hidden inert>
            {props.fallback}
          </span>
        ) : null}
        {errorNote}
      </div>
    </TooltipProvider>
  );
}

/** How long a handoff may take, mounting BB's picker included, before it counts as failed. */
const HANDOFF_DEADLINE_MS = 15_000;

/**
 * Starts BB's handoff through BB's picker: the one shown in place of these pickers, or, beside
 * them, one mounted out of sight for the drive.
 */
function useHandoffDriver(
  anchor: { readonly current: HTMLElement | null },
  report: (message: string | null) => void,
) {
  const [driving, setDriving] = useState(false);
  const host = useRef<HTMLElement | null>(null);
  const hostWaiter = useRef<((node: HTMLElement) => void) | null>(null);
  const busy = useRef(false);
  const attachHost = useCallback((node: HTMLElement | null) => {
    host.current = node;
    if (node) hostWaiter.current?.(node);
  }, []);

  const start = useCallback(async () => {
    if (busy.current) return false;
    const at = anchor.current ?? host.current;
    // BB hides the composer to show the agent's question or approval; see `apply` above.
    if (at && !isAnchorInteractive(at)) {
      report("Answer the agent's question first.");
      return false;
    }
    busy.current = true;
    report(null);
    setDriving(true);
    const signal = AbortSignal.timeout(HANDOFF_DEADLINE_MS);
    try {
      const picker =
        host.current ??
        (await new Promise<HTMLElement>((resolve, reject) => {
          hostWaiter.current = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
      await startBbHandoff(picker, signal);
      return true;
    } catch (reason) {
      report(
        reason instanceof BbSwitchMissing || !(reason instanceof Error)
          ? "Handoff isn't available here."
          : reason.message,
      );
      return false;
    } finally {
      hostWaiter.current = null;
      busy.current = false;
      setDriving(false);
    }
  }, [anchor, report]);

  return { driving, attachHost, start };
}
