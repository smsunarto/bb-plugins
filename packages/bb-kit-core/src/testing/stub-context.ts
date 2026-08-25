import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContext, type Context } from "../plugin/plugin.ts";

function memoryKv(): BbPluginApi["storage"]["kv"] {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | undefined> => map.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix?: string) =>
      [...map.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)),
  };
}

/**
 * Frozen `{ bb }` stub for tier-1 tests. Goes through `hostContext`.
 * Mints a fresh `bb` unless one is passed. A passed `bb` keeps its
 * identity. Missing `sdk`/`storage` are filled on that host object,
 * never copied onto the returned record. The object is not a live
 * host. The cast is the test seam.
 */
export function stubHostContext(overrides: Partial<Context> = {}): Context {
  const bb = (overrides.bb ?? Object.create(null)) as BbPluginApi;
  const host = bb as BbPluginApi & { sdk?: BbPluginApi["sdk"]; storage?: BbPluginApi["storage"] };
  if (host.sdk === undefined) {
    host.sdk = {} as BbPluginApi["sdk"];
  }
  if (host.storage === undefined) {
    host.storage = { kv: memoryKv() } as BbPluginApi["storage"];
  }
  return hostContext(bb);
}
