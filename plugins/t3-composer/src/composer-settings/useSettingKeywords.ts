import { useEffect, useRef } from "react";
import {
  experimental_useComposerRenderer as useComposerRenderer,
  experimental_useProviders as useProviders,
  useComposer,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { listedModelName } from "../model-picker/catalog";
import type { StarredModel } from "../starred-models/contract";
import { useStarredModels } from "../starred-models/useStarredModels";
import { applySelection } from "./apply-selection";
import {
  findKeywords,
  keywordSelection,
  withoutRanges,
  type KeywordSources,
} from "./setting-keywords";

type Providers = ReturnType<typeof useProviders>["providers"];

/**
 * Applies setting keywords typed in the draft: once `#high` or `#opus` is followed by a
 * space, the keyword is removed and its setting goes to the pickers through `setSelection`.
 */
export function useSettingKeywords() {
  const composer = useComposer();
  const { showError } = useComposerRenderer();
  const { providers } = useProviders();
  // Settings apply in the order they were typed, each after the one before has settled.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const text = composer.draft.text;
  // The server's stars are read once a `#` is typed; this device's last list serves until then.
  const { models: starred } = useStarredModels({ enabled: text.includes("#") });

  useEffect(() => {
    // Most keystrokes add no `#` word, so they skip the scan.
    if (!text.includes("#")) return;
    const sources = keywordSources(providers, starred);
    const keywords = findKeywords(composer.draft, sources);
    if (keywords.length === 0) return;
    composer.replace((current) => {
      const present = findKeywords(current, sources);
      return present.length === 0 ? current : withoutRanges(current, present);
    });
    for (const { word } of keywords) {
      const request = keywordSelection(word, sources);
      queue.current = queue.current.then(() => applyKeyword(composer, showError, request));
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps -- runs per text change, and again when the stars arrive, with the other inputs as they are then.
  }, [text, starred]);
}

async function applyKeyword(
  composer: PluginComposerApi,
  showError: (message: string) => void,
  request: ReturnType<typeof keywordSelection>,
) {
  if (request === null) return;
  if ("error" in request) {
    showError(request.error);
    return;
  }
  const { error } = await applySelection(composer, request.selection);
  if (error) showError(error);
}

function keywordSources(providers: Providers, starred: readonly StarredModel[]): KeywordSources {
  const available = providers.filter((provider) => provider.available);
  const providerIds = new Set(available.map((provider) => provider.id));
  return {
    reasoningLevels: new Set(
      available.flatMap((provider) => (provider.reasoningLevels ?? []).map((level) => level.id)),
    ),
    starredModels: starred
      .filter((entry) => providerIds.has(entry.providerId))
      .map((entry) => ({
        providerId: entry.providerId,
        model: entry.model,
        label: listedModelName(entry.providerId, entry.model),
      })),
  };
}
