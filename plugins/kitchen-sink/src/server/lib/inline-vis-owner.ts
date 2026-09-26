import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** bb's built-in plugin that also claims `::inline-vis`. */
export const BUILTIN_INLINE_VIS_PLUGIN_ID = "inline-vis";

/**
 * bb leaves a directive as literal text when two plugins claim it, so a fresh
 * install turns the built-in renderer off once. Re-enabling it later is the
 * user's choice; update, reload, and restart leave it alone.
 */
export function registerInlineVisOwner(bb: BbPluginApi): void {
  bb.onInstall(async () => {
    await bb.sdk.plugins.disable({ pluginId: BUILTIN_INLINE_VIS_PLUGIN_ID });
  });
}
