/**
 * The `bb.host` artifact. One line, like amp's: the runtime discovers the
 * bridge by looking for the `PROVIDER_BRIDGE_EXPORT_NAME` export on this
 * module. `bb.providers.register` is refused outright if the plugin has no
 * `bb.host` entry, so this file is not optional.
 *
 * No `experimental_defineHostEntry`: this plugin registers no RPC contract, no
 * AI services and no native roots. If a settings panel later needs one, it is
 * added here beside the re-export, not in place of it.
 */
export { experimental_providerBridge } from "./src/bridge/entry.ts";
export {
  initializeEmbeddedNanocodexModule as experimental_initializeNanocodexModule,
} from "./src/binding.ts";
