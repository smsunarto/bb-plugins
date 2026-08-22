import type { StandardSchemaV1 } from "../rpc/standard-schema.ts";
import type { MaybePromise } from "../internal/types.ts";

/**
 * The structural host seam (§2, §6): the two registration surfaces
 * `definePlugin` needs from bb, spelled without importing SDK types so
 * the emitted declarations never reference `@get-bb/plugin-sdk`. The
 * real `BbPluginApi` assigns to `HostSeam` cast-free (verified against
 * SDK 0.4.8 in host.test.ts) — `register` is method syntax on purpose,
 * so parameters compare bivariantly.
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
