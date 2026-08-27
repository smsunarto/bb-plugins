// A leaf on purpose: production bb loads a path-installed plugin's server.ts
// from source, and its runtime shim cannot resolve @get-bb/plugin-sdk
// subpaths, so everything server.ts reaches must stay off them.

/** Namespaced extension kinds this bridge may emit. Must match the plugin
 *  declaration's `extensionKinds` keys — the server validates payloads against
 *  those schemas and persists `provider/unhandled` on a miss. */
export const AMP_ORACLE_KIND = "amp/oracle";
export const AMP_THREAD_LINK_KIND = "amp/thread-link";
