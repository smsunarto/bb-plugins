import type { BbPluginApi, PluginMentionItem } from "@get-bb/plugin-sdk";
import { isPluginBrowseQuery } from "./mention-query";
import { installedIconName } from "./plugin-icon";

import {
  MAX_ITEM_SUBTITLE_BYTES,
  MAX_ITEM_TITLE_BYTES,
  boundUntrustedText,
  encodeInstalledItemId,
  normalizeStableIdentity,
  normalizeUntrustedText,
} from "./mention-context";

export type InstalledPluginRecord = Awaited<
  ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>
>["plugins"][number];

interface InstalledCandidate {
  plugin: InstalledPluginRecord;
  pluginId: string;
  displayName: string;
  description: string;
  normalizedName: string;
  tier: number;
}

const RESULT_LIMIT = 6;

function folded(value: string): string {
  return value.toLowerCase();
}

function compareText(left: string, right: string): number {
  return folded(left).localeCompare(folded(right), "en");
}

function matchTier(
  query: string,
  displayName: string,
  pluginId: string,
  description: string,
): number | null {
  const foldedQuery = folded(normalizeUntrustedText(query));
  if (foldedQuery.length === 0) return 2;

  const name = folded(displayName);
  const id = folded(pluginId);
  const detail = folded(description);
  if (name === foldedQuery || id === foldedQuery) return 0;
  if ([name, id, detail].some((field) => field.startsWith(foldedQuery))) return 1;
  if ([name, id, detail].some((field) => field.includes(foldedQuery))) return 2;
  return null;
}

export function isUsableInstalledTarget(plugin: InstalledPluginRecord): boolean {
  return (
    normalizeStableIdentity(plugin.id) !== null && plugin.enabled && plugin.status === "running"
  );
}

export function searchInstalledPlugins(
  plugins: readonly InstalledPluginRecord[],
  query: string,
  options: { limit?: number | null } = {},
): PluginMentionItem[] {
  const browse = isPluginBrowseQuery(query);
  const eligible = plugins.flatMap((plugin): InstalledCandidate[] => {
    if (!isUsableInstalledTarget(plugin)) return [];

    const pluginId = normalizeStableIdentity(plugin.id);
    if (pluginId === null) return [];
    const displayName = normalizeUntrustedText(plugin.name ?? pluginId) || pluginId;
    const description = normalizeUntrustedText(plugin.description ?? "");
    const tier = matchTier(browse ? "" : query, displayName, pluginId, description);
    if (tier === null) return [];

    return [
      {
        plugin,
        pluginId,
        displayName,
        description,
        normalizedName: folded(displayName),
        tier,
      },
    ];
  });

  const duplicateNames = new Set(
    Array.from(
      eligible.reduce((counts, candidate) => {
        counts.set(candidate.normalizedName, (counts.get(candidate.normalizedName) ?? 0) + 1);
        return counts;
      }, new Map<string, number>()),
    )
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );

  return eligible
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        compareText(left.displayName, right.displayName) ||
        compareText(left.pluginId, right.pluginId),
    )
    .slice(0, options.limit === null || browse ? undefined : (options.limit ?? RESULT_LIMIT))
    .map((candidate) => {
      const subtitleParts = duplicateNames.has(candidate.normalizedName)
        ? [candidate.pluginId, candidate.description]
        : [candidate.description];
      const subtitle = boundUntrustedText(
        subtitleParts.filter(Boolean).join(" · "),
        MAX_ITEM_SUBTITLE_BYTES,
      );

      const item: PluginMentionItem = {
        id: encodeInstalledItemId(candidate.pluginId),
        title: boundUntrustedText(candidate.displayName, MAX_ITEM_TITLE_BYTES),
        icon: installedIconName(candidate.plugin),
      };
      if (subtitle.length > 0) item.subtitle = subtitle;
      return item;
    });
}
