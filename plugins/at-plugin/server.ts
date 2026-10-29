import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { boundedSdkRead } from "./sdk-read";
import {
  type InstalledPluginRecord,
  isUsableInstalledTarget,
  searchInstalledPlugins,
} from "./installed-catalog";
import {
  MAX_ITEM_TITLE_BYTES,
  boundUntrustedText,
  buildInstalledPluginContext,
  decodeInstalledItemId,
} from "./mention-context";
export { SDK_READ_TIMEOUT_MS } from "./sdk-read";

function targetName(plugin: InstalledPluginRecord): string {
  return (
    boundUntrustedText(plugin.name ?? "", MAX_ITEM_TITLE_BYTES) ||
    boundUntrustedText(plugin.id, MAX_ITEM_TITLE_BYTES) ||
    "This plugin"
  );
}

function fallbackTarget(pluginId: string): string {
  return boundUntrustedText(pluginId, MAX_ITEM_TITLE_BYTES) || "This plugin";
}

function missingInstalledError(target: string): Error {
  return new Error(
    `${target} is no longer installed. Reinstall it in Plugins settings or remove #${target}, then retry.`,
  );
}

function unusableInstalledError(target: string): Error {
  return new Error(
    `${target} is not currently usable. Restore it in Plugins settings or remove #${target}, then retry.`,
  );
}

function inventoryVerificationError(target: string): Error {
  return new Error(
    `${target} could not be verified right now. Retry, or remove #${target} to send without it.`,
  );
}

function invalidInstalledReferenceError(): Error {
  return new Error(
    "This Installed plugin reference is invalid. Remove the mention and choose the plugin again.",
  );
}

function findInstalledPlugin(
  plugins: readonly InstalledPluginRecord[],
  pluginId: string,
): InstalledPluginRecord | undefined {
  return plugins.find((plugin) => plugin.id === pluginId);
}

function resolveInstalledRecord(plugin: InstalledPluginRecord): { context: string } {
  const target = targetName(plugin);
  if (!isUsableInstalledTarget(plugin)) throw unusableInstalledError(target);

  return {
    context: buildInstalledPluginContext({ name: target, pluginId: plugin.id }),
  };
}

export default function plugin(bb: BbPluginApi) {
  bb.ui.registerMentionProvider({
    id: "installed",
    label: "Installed plugins",
    triggers: ["#"],
    async search({ query, trigger }) {
      if (trigger === "#" && query.trim().toLowerCase() === "plugins") query = "plugin";
      try {
        const inventory = await boundedSdkRead((signal) => bb.sdk.plugins.list({ signal }));
        return searchInstalledPlugins(inventory.plugins, query);
      } catch {
        return [];
      }
    },
    async resolve(itemId) {
      let pluginId: string;
      try {
        pluginId = decodeInstalledItemId(itemId).pluginId;
      } catch {
        throw invalidInstalledReferenceError();
      }

      const fallback = fallbackTarget(pluginId);
      let inventory: Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>>;
      try {
        inventory = await boundedSdkRead((signal) => bb.sdk.plugins.list({ signal }));
      } catch {
        throw inventoryVerificationError(fallback);
      }

      const installed = findInstalledPlugin(inventory.plugins, pluginId);
      if (installed === undefined) throw missingInstalledError(fallback);
      return resolveInstalledRecord(installed);
    },
  });
}
