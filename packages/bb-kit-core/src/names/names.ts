/**
 * Every naming rule a plugin's ids and map keys follow. The runtime
 * (`definePlugin`, `createRPC`) and `@bb-kit/dev` (`check`, `add`,
 * `create`) all read these, so a rule changes in one place.
 */

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const RPC_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Keys the `./rpc/query` proxy answers itself. `useClient` is the
 * imperative escape hatch, and `then` stays undefined so the proxy is
 * never a thenable. An RPC under either name would be unreachable from
 * app/.
 */
export const RESERVED_RPC_KEYS: readonly string[] = ["useClient", "then"];

/** `rpc` is the always-mounted RPC subtree. `help` is the SDK's help word. */
export const RESERVED_COMMAND_KEYS: readonly string[] = ["rpc", "help"];

export const TOOL_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export type UnitKind = "rpc" | "command" | "tools";

/** `quick-list` → `quickList`. */
export function camelName(name: string): string {
  const [first = "", ...rest] = name.split("-");
  return first + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

/**
 * The map key a unit file is wired under, from its kebab basename:
 * RPCs are camelCase, commands keep the kebab name, tools are
 * snake_case.
 */
export function unitKey(kind: UnitKind, basename: string): string {
  switch (kind) {
    case "rpc":
      return camelName(basename);
    case "command":
      return basename;
    case "tools":
      return basename.replaceAll("-", "_");
  }
}

/**
 * A tool's public name. The host applies no namespace and rejects
 * cross-plugin collisions, so bb-kit prefixes the plugin id. Authors
 * never type the prefix.
 */
export function toolName(pluginId: string, key: string): string {
  return `${pluginId.replaceAll("-", "_")}_${key}`;
}
