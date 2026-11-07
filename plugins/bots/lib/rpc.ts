import { useMemo } from "react";
import { useSdk, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { BOTS_PLUGIN_ID, rpcContract } from "../contract";
import type { z } from "zod";

export type BotsRpc = PluginRpcClient<typeof rpcContract>;
type Method = Extract<keyof typeof rpcContract, string>;

/**
 * Calls the Bots plugin's RPC from whichever plugin bundle renders the caller:
 * Bots' own thread surfaces, or the Bots shelf inside GTD Sidebar. `useRpc`
 * binds to the rendering plugin, so it cannot reach Bots from GTD's bundle.
 */
export function useBotsRpc(): BotsRpc {
  const sdk = useSdk();
  return useMemo<BotsRpc>(
    () => ({
      call: ((method: Method, input?: unknown) =>
        sdk.plugins.callRpc({
          pluginId: BOTS_PLUGIN_ID,
          method,
          input: (input ?? {}) as never,
          outputSchema: rpcContract[method].output as z.ZodType<unknown>,
        })) as BotsRpc["call"],
    }),
    [sdk],
  );
}
