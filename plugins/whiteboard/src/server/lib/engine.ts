import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Engine, WhiteboardSettings } from "../../shared/contracts/engine.ts";

/**
 * The single in-process engine: store, local data, `createReviewApi`, loopback
 * client, realtime and tab subscriptions (design §3.10). Owned by WP7.
 *
 * WP0 stub: constructs nothing, so the plugin loads. Every call throws.
 */
export function createEngine(_bb: BbPluginApi, _settings: WhiteboardSettings): Engine {
  const notWired = (fn: string) => (): never => {
    throw new Error(`whiteboard: engine.${fn} not wired`);
  };
  return {
    request: async () => notWired("request")(),
    info: async () => notWired("info")(),
    client: notWired("client"),
    withThread: async () => notWired("withThread")(),
    dispose: async () => {},
  };
}
