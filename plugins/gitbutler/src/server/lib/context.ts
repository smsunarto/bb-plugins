import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** What every RPC handler receives. The plugin has no services beyond the host. */
export type GitButlerContext = Readonly<{ bb: BbPluginApi }>;
