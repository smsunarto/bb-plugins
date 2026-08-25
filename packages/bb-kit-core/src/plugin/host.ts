import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StandardSchemaV1 } from "../rpc/rpc.ts";
import type { MaybePromise } from "../utils/types.ts";

/**
 * The registration subset `definePlugin` actually calls. `BbPluginApi`
 * assigns to it (verified in host.test.ts). Kept structural so tests
 * can supply a slim fake host for `rpc.register` / `cli.register`
 * without constructing the rest of the SDK object.
 */
export type HostRPCSeam = {
  rpc: {
    register(
      contract: Readonly<
        Record<string, { readonly input: StandardSchemaV1; readonly output: StandardSchemaV1 }>
      >,
      handlers: Readonly<Record<string, (input: unknown) => MaybePromise<unknown>>>,
    ): void;
  };
};

export type HostCLISeam = {
  cli: {
    register(registration: {
      name: string;
      summary: string;
      commands?: { name: string; summary: string; usage: string }[];
      run(
        argv: string[],
        ctx: { cwd?: string; threadId?: string; projectId?: string; signal?: AbortSignal },
      ): MaybePromise<{ exitCode: number; stdout?: string; stderr?: string }>;
    }): void;
  };
};

export type HostSeam = HostRPCSeam & HostCLISeam;

/**
 * Frozen host preset every handler receives. Plugins import this; they
 * do not apply a Host generic and they do not keep a local alias.
 * Host capabilities (`sdk`, `storage`, …) live on `bb`.
 */
export type Context = {
  readonly bb: BbPluginApi;
};

/**
 * The only place `{ bb }` is derived from the host. Production and
 * `@bb-kit/core/testing` both go through it. The result is frozen so
 * extras cannot be assigned onto it. Freezing is shallow. `context.bb`
 * is the host's own object and stays live.
 */
export function hostContext(bb: BbPluginApi): Context {
  return Object.freeze({ bb });
}
