import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** bb's built-in plugin that also claims `::inline-vis`. */
export const BUILTIN_INLINE_VIS_PLUGIN_ID = "inline-vis";

export const INSTRUCTIONS =
  "Show images and recordings inline. Before embedding HTML, Markdown, or video, read the `inline-vis` skill. Its `file` must be an existing absolute filesystem path on the thread host. Resolve relative paths and expand variables before emitting the directive. Never use `source`. Relative asset URLs inside HTML are allowed.";

export default async function plugin(bb: BbPluginApi) {
  bb.agents.contributeInstructions(() => INSTRUCTIONS);
  // bb leaves a directive as literal text when two plugins claim it, so a fresh
  // install turns the built-in renderer off once. Re-enabling it later is the
  // user's choice; update, reload, and restart leave it alone.
  bb.onInstall(async () => {
    await bb.sdk.plugins.disable({ pluginId: BUILTIN_INLINE_VIS_PLUGIN_ID });
  });
}
