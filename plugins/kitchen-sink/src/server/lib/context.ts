import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** What every RPC handler receives: the host. This plugin has no services. */
export type KitchenSinkContext = Readonly<{ bb: BbPluginApi }>;
