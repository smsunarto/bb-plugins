import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * A `{ bb }` context whose thread lookup and host client are both recorded.
 * Every RPC in this plugin does the same two things — resolve the thread's
 * environment, then forward to the host — so the tests assert on what reached
 * the host rather than re-deriving it.
 */

export type HostCall = { method: string; input: unknown; options: unknown };

type Environment = { id?: string; hostId: string; path: string | null; status: string };

type Host = { name: string; status: "connected" | "disconnected" };

export function harness(options: {
  environment?: Environment | null;
  result?: unknown;
  /** What the host call rejects with, in place of answering `result`. */
  error?: Error;
  /** What bb says about the environment's host. Any other host is not found. */
  host?: Host;
}) {
  const calls: HostCall[] = [];
  const environment =
    options.environment === undefined
      ? { id: "env-1", hostId: "host-1", path: "/work", status: "ready" }
      : options.environment;
  const bb = {
    sdk: {
      threads: { get: async () => ({ environment }) },
      hosts: {
        get: async ({ hostId }: { hostId: string }) => {
          if (!options.host || hostId !== environment?.hostId) throw new Error("Host not found");
          return { id: hostId, ...options.host };
        },
      },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, callOptions: unknown) => {
          calls.push({ method, input, options: callOptions });
          if (options.error) throw options.error;
          return options.result;
        },
      }),
    },
  } as unknown as BbPluginApi;

  return { ctx: { bb }, calls };
}
