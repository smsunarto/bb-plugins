import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { InstalledPlugin } from "./agent-text.ts";

export async function installedPlugins(bb: BbPluginApi): Promise<InstalledPlugin[]> {
  return (await bb.sdk.plugins.list()).plugins;
}

export async function installedPlugin(bb: BbPluginApi, pluginId: string): Promise<InstalledPlugin> {
  const plugin = (await installedPlugins(bb)).find((p) => p.id === pluginId);
  if (!plugin) throw new Error(`No installed plugin ${pluginId}`);
  return plugin;
}
