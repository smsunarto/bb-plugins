import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** What every RPC handler receives: the host. This plugin has no services. */
export type TracesContext = Readonly<{ bb: BbPluginApi }>;
