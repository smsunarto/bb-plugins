// A plain-fetch rpc client with the same types as the host's `useRpc`.
//
// React slots get `useRpc`, but a content script has no host React context, so
// it calls the documented wire endpoint directly. bb's own client posts the
// same request with the global fetch and no extra credentials, so this behaves
// identically — including through the remote-access tunnel, where the URL is
// still same-origin.

import type {
  PluginRpcCallArgs,
  PluginRpcClient,
  PluginRpcContract,
  PluginRpcMethodContract,
  PluginRpcResult,
} from "@get-bb/plugin-sdk/app";

interface RpcEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export class PluginRpcCallError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PluginRpcCallError";
    this.code = code;
  }
}

export function createRpcClient<Contract extends PluginRpcContract>(
  pluginId: string,
  options: { signal?: AbortSignal } = {},
): PluginRpcClient<Contract> {
  return {
    async call<Method extends Extract<keyof Contract, string>>(
      method: Method,
      ...args: PluginRpcCallArgs<Contract[Method]>
    ): Promise<PluginRpcResult<Contract[Method]>> {
      const response = await fetch(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args[0] ?? null),
          signal: options.signal,
        },
      );

      const envelope = (await response.json().catch(() => null)) as RpcEnvelope | null;

      if (!envelope?.ok) {
        throw new PluginRpcCallError(
          envelope?.error?.message ?? `rpc ${method} failed (${response.status})`,
          envelope?.error?.code ?? "transport_error",
        );
      }

      return envelope.result as PluginRpcResult<Contract[Method]>;
    },
  };
}

export type { PluginRpcMethodContract };
