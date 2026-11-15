import { useMemo } from "react";
import {
  experimental_useRpcQuery as useRpcQuery,
  type ExperimentalComposerCommandSuggestion,
} from "@get-bb/plugin-sdk/app";
import type { MentionTarget } from "../editor/composer-mentions";
import {
  INLINE_PROMPT_PROVIDER_ID,
  T3_COMPOSER_PLUGIN_ID,
  inlinePromptsContract,
} from "./contract";

const NO_NAMES: ReadonlySet<string> = new Set();

/** Names of the user-tier skills marked `inline: true`; empty until the server answers. */
export function useInlinePromptNames(): ReadonlySet<string> {
  const query = useRpcQuery({
    contract: inlinePromptsContract,
    method: "inlinePrompts",
    input: null,
  });
  const names = query.data?.names;
  return useMemo(() => (names ? new Set(names) : NO_NAMES), [names]);
}

/**
 * The pill a `/` menu pick inserts when the skill is an inline prompt: a mention the server
 * resolves to the skill's body at send time. Null keeps the ordinary skill pill.
 */
export function inlinePromptMentionTarget(
  item: Pick<ExperimentalComposerCommandSuggestion, "name" | "source" | "origin">,
  names: ReadonlySet<string>,
): Extract<MentionTarget, { kind: "plugin" }> | null {
  if (item.source !== "skill" || item.origin !== "user" || !names.has(item.name)) return null;
  return {
    kind: "plugin",
    pluginId: T3_COMPOSER_PLUGIN_ID,
    provider: INLINE_PROMPT_PROVIDER_ID,
    id: item.name,
    icon: "Zap",
    label: item.name,
  };
}
