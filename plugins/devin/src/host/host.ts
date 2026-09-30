// Devin speaks ACP natively (`devin acp`), so the plugin runs it through the
// SDK's generic ACP bridge. The launch spec arrives per command in the
// provider options (src/server/lib/declaration.ts).
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
