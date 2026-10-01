import type { BbPluginApi } from "@get-bb/plugin-sdk";
import packageJson from "../../../package.json" with { type: "json" };
import type { JsonObject } from "../../shared/vendor/json/src/index.ts";

/** The plugin's own version: what `appVersion` reports to agents and panels. */
export const PLUGIN_VERSION: string = packageJson.version;

function serverField(read: () => string): string | null {
  try {
    return read();
  } catch {
    // `bb.server` fields are bind-gated: unreadable before the server listens.
    return null;
  }
}

/**
 * The `status` callback `createReviewApi` receives: which server this is, for
 * `whiteboard_status` (design §3.7). Same keys, in the same order, as
 * upstream Desktop's status (`desktop-server.ts:260-272`); `http.ts` adds
 * `desktopAvailable`.
 *
 * - `key` is "stable", one of the values the verbatim tool description names.
 * - `channel` says this Whiteboard runs as a bb plugin. There is no checkout,
 *   CLI or listening URL.
 * - `instanceId` is the bb server's loopback URL, since bb has no server
 *   instance id. `home` is bb's data directory (advisory, read-only).
 */
export function createStatus(bb: BbPluginApi): () => JsonObject {
  return () => ({
    key: "stable",
    channel: "bb-plugin",
    checkout: null,
    appVersion: PLUGIN_VERSION,
    cliVersion: null,
    instanceId: serverField(() => bb.server.loopbackBaseUrl),
    url: null,
    home: serverField(() => bb.server.experimental_dataDir),
  });
}
