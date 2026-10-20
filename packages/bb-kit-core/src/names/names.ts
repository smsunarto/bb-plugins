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

/**
 * Full public tool names, including compatibility aliases, follow the
 * host syntax. The checker also applies the installed host name policy.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

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
 * cross-plugin collisions, so bb-kit prefixes the plugin's public name
 * (`definePlugin`'s `publicName`, else its id). Authors never type the
 * prefix.
 */
export function toolName(publicName: string, key: string): string {
  return `${publicName.replaceAll("-", "_")}_${key}`;
}

/**
 * Where a tool's description lives, relative to the plugin root.
 * `@bb-kit/core/instructions` reads it; `bb-kit add` and `check` write and
 * verify it.
 */
export function toolDescriptionFile(publicName: string): string {
  return `instructions/tools/${publicName}.md`;
}

/** One registration per canonical tool or alias; aliases target a tool map key. */
export type ToolRegistration = { name: string; key: string; alias: boolean };

/**
 * Runtime and checker share the naming policy. Runtime throws on the
 * first invalid alias; check supplies a reporter to collect all failures
 * with source locations and keep checking valid registrations.
 */
export function toolRegistrations(
  publicName: string,
  keys: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
  invalid: (message: string, name: string) => void = (message) => {
    throw new Error(message);
  },
): ToolRegistration[] {
  const registrations = keys.map((key) => ({ name: toolName(publicName, key), key, alias: false }));
  const targets = new Set(keys);
  const taken = new Set(registrations.map(({ name }) => name));
  for (const [name, key] of Object.entries(aliases)) {
    if (!TOOL_NAME_PATTERN.test(name)) {
      invalid(`invalid tool alias "${name}": must match ${TOOL_NAME_PATTERN}`, name);
    } else if (!targets.has(key)) {
      invalid(`tool alias "${name}" targets "${key}", which is not an agents.tools key`, name);
    } else if (taken.has(name)) {
      invalid(`tool alias "${name}" collides with a tool of the same name`, name);
    } else {
      taken.add(name);
      registrations.push({ name, key, alias: true });
    }
  }
  return registrations;
}
