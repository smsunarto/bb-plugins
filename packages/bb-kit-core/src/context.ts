import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * What every RPC, command, and tool `execute` receives. `bb` is the
 * host. `Services` is whatever the plugin's `services(bb)` returns,
 * built once per plugin load. A handler that needs a service annotates
 * its `ctx` with `Context<{ git: Git }>`, and `definePlugin` checks the
 * plugin provides it.
 */
export type Context<Services extends object = Record<never, never>> = Readonly<
  { bb: BbPluginApi } & Services
>;
