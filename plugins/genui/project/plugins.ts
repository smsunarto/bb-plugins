// Plugins: BB's state of the plugins a reply names, by id, through the SDK's
// plugin list. Only the ids asked for and the few fields the component shows
// are returned. Readers that ask at the same moment share one list.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PLUGIN_ID, type PluginInfo, type PluginState } from "../core/plugins";
import type { PluginsResult } from "../core/project";

type Sdk = BbPluginApi["sdk"];

/** The fields of BB's plugin list entry Plugins reads. */
export interface PluginEntry {
  readonly id: string;
  readonly name: string | null;
  readonly version?: string | null;
  readonly icon?: string | null;
  readonly sourceDisplay: string;
  readonly sourceNotice: string | null;
  readonly status: PluginInfo["status"];
  readonly statusDetail: string | null;
}

/** How long BB may take to list its plugins. */
const LIST_DEADLINE_MS = 10_000;

export interface PluginsSource {
  plugins(ids: readonly string[]): Promise<PluginsResult>;
}

export function pluginInfo(entry: PluginEntry): PluginInfo {
  return {
    found: true,
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    version: entry.version ?? null,
    icon: entry.icon ?? null,
    source: entry.sourceDisplay,
    sourceNotice: entry.sourceNotice,
    status: entry.status,
    statusDetail: entry.statusDetail,
  };
}

export function createPluginsSource(sdk: Sdk): PluginsSource {
  let listing: Promise<readonly PluginEntry[]> | null = null;

  function list(): Promise<readonly PluginEntry[]> {
    if (listing !== null) return listing;
    const reading: Promise<readonly PluginEntry[]> = sdk.plugins
      .list({ signal: AbortSignal.timeout(LIST_DEADLINE_MS) })
      .then((answer) => answer.plugins)
      .finally(() => {
        listing = null;
      });
    listing = reading;
    return reading;
  }

  return {
    async plugins(ids) {
      const invalid = ids.find((id) => !PLUGIN_ID.test(id));
      if (invalid !== undefined)
        return { ok: false, reason: "invalid", message: `"${invalid}" is not a plugin id` };
      try {
        const installed = new Map((await list()).map((entry) => [entry.id, entry]));
        const plugins = ids.map((id): PluginState => {
          const entry = installed.get(id);
          return entry === undefined ? { found: false, id } : pluginInfo(entry);
        });
        return { ok: true, plugins, fetchedAt: Date.now() };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          ok: false,
          reason: "unavailable",
          message: `BB couldn't list its plugins: ${message}`,
        };
      }
    },
  };
}
