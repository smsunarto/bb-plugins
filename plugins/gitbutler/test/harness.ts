import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stubHostContext } from "@bb-kit/core/testing";

/**
 * A `{ bb }` context whose thread lookup and host client are both recorded.
 * Every RPC in this plugin does the same two things — resolve the thread's
 * environment, then forward to the host — so the tests assert on what reached
 * the host rather than re-deriving it.
 */

export type HostCall = { method: string; input: unknown; options: unknown };

type Environment = { hostId: string; path: string | null; status: string };

export function harness(options: {
  environment?: Environment | null;
  result?: unknown;
  hostError?: Error;
}) {
  const calls: HostCall[] = [];
  const bb = {
    sdk: {
      threads: {
        get: async () =>
          options.environment === undefined
            ? { environment: { hostId: "host-1", path: "/work", status: "ready" } }
            : { environment: options.environment },
      },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, callOptions: unknown) => {
          calls.push({ method, input, options: callOptions });
          if (options.hostError) throw options.hostError;
          return options.result;
        },
      }),
    },
  } as unknown as BbPluginApi;

  return { ctx: stubHostContext({ bb }), calls };
}
