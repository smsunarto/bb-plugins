import { createElement, useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation as useTanStackMutation,
  useQuery as useTanStackQuery,
} from "@tanstack/react-query";
import type {
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { RESERVED_RPC_KEYS } from "../../names/names.ts";
import type { Client, RPCProcedures, SchemaInput, SchemaOutput, StandardSchemaV1 } from "../rpc.ts";

/** Public surface of `@bb-kit/core/rpc/query` (§1, §5). */

/**
 * TanStack's query options minus what the accessor owns (`queryKey`,
 * `queryFn`) — the spec's "options = TanStack's object minus the two
 * derived fields" (§5). `TData` is pinned to the output type: the
 * `select` transform is accepted at runtime but not modeled in types.
 */
type QueryOptionsFor<Out> = Omit<
  UseQueryOptions<Out, Error, Out, QueryKey>,
  "queryKey" | "queryFn"
>;

type MutationOptionsFor<Out, In> = Omit<UseMutationOptions<Out, Error, In>, "mutationFn">;

type QueryHooksNoInput<Out> = {
  useQuery(options?: QueryOptionsFor<Out>): UseQueryResult<Out, Error>;
  queryKey(): QueryKey;
};

type QueryHooksWithInput<In, Out> = {
  useQuery(input: In, options?: QueryOptionsFor<Out>): UseQueryResult<Out, Error>;
  queryKey(input?: In): QueryKey;
};

type MutationHooksNoInput<Out> = {
  useMutation(options?: MutationOptionsFor<Out, void>): UseMutationResult<Out, Error, void>;
};

type MutationHooksWithInput<In, Out> = {
  useMutation(options?: MutationOptionsFor<Out, In>): UseMutationResult<Out, Error, In>;
};

/**
 * The per-RPC accessor, discriminated on the `kind` field (§5):
 * a Query exposes `useQuery`/`queryKey`, a Mutation only `useMutation`.
 * Input presence carries through — a with-input `useQuery` REQUIRES its
 * input, a no-input one has no input parameter at all.
 */
type ProcedureHooks<P> = P extends { kind: "query" }
  ? P extends {
      input: infer In extends StandardSchemaV1;
      output: infer Out extends StandardSchemaV1;
    }
    ? QueryHooksWithInput<SchemaInput<In>, SchemaOutput<Out>>
    : P extends { output: infer Out extends StandardSchemaV1 }
      ? QueryHooksNoInput<SchemaOutput<Out>>
      : never
  : P extends { kind: "mutation" }
    ? P extends {
        input: infer In extends StandardSchemaV1;
        output: infer Out extends StandardSchemaV1;
      }
      ? MutationHooksWithInput<SchemaInput<In>, SchemaOutput<Out>>
      : P extends { output: infer Out extends StandardSchemaV1 }
        ? MutationHooksNoInput<SchemaOutput<Out>>
        : never
    : never;

type RPCHooks<P extends RPCProcedures> = {
  readonly [K in keyof P]: ProcedureHooks<P[K]>;
} & {
  /** The imperative escape hatch (§5): the typed client, per render. */
  useClient(): Client<P>;
};

type RPCTransport = { call(method: string, input?: unknown): Promise<unknown> };

/** The SDK client behind one structural seam, resolved at render time. */
function useTransport(): RPCTransport {
  return useRpc() as unknown as RPCTransport;
}

/**
 * The wire input for a call. No-input calls send `null`, matching the
 * SDK. Keys holding `undefined` are dropped, so `{ id, cursor }` with
 * no cursor passes a `.strict()` schema that only allows `cursor?`.
 */
function wireInput(input: unknown): unknown {
  if (input === undefined || input === null) {
    return null;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/**
 * Every own key of TanStack v5's `UseQueryOptions` minus the two the
 * accessor derives (extracted from @tanstack/react-query 5.101). Drives
 * the single-argument `useQuery` reading below.
 *
 * DRIFT: the peer range is ^5, so a newer TanStack minor can add option
 * keys this hardcoded list does not know. TanStack exports no runtime
 * list to derive from, so the set is pinned by hand — re-extract it when
 * bumping the pinned @tanstack/react-query version. An unknown new key
 * makes a sole-argument object read as INPUT (failing loud on the wire),
 * never the reverse; `useQuery(input, {})` stays the unambiguous escape.
 */
const QUERY_OPTION_KEYS = new Set([
  "_defaulted",
  "_optimisticResults",
  "_type",
  "behavior",
  "enabled",
  "experimental_prefetchInRender",
  "gcTime",
  "initialData",
  "initialDataUpdatedAt",
  "maxPages",
  "meta",
  "networkMode",
  "notifyOnChangeProps",
  "persister",
  "placeholderData",
  "queryHash",
  "queryKeyHashFn",
  "refetchInterval",
  "refetchIntervalInBackground",
  "refetchOnMount",
  "refetchOnReconnect",
  "refetchOnWindowFocus",
  "retry",
  "retryDelay",
  "retryOnMount",
  "select",
  "staleTime",
  "structuralSharing",
  "subscribed",
  "throwOnError",
]);

/**
 * Read `useQuery(...)`'s arguments. Two or more arguments are always
 * `(input, options)`. A single defined argument is OPTIONS iff it is a
 * plain non-array object with at least one own enumerable key and EVERY
 * key is a known TanStack option key; otherwise it is INPUT (so `{}`
 * reads as input — all-optional input schemas exist, empty options are
 * pointless). Either misroute fails loud on the wire; the two-argument
 * form is the unambiguous escape.
 */
function readUseQueryArguments(args: readonly unknown[]): { input: unknown; options: object } {
  if (args.length >= 2) {
    return { input: args[0], options: (args[1] ?? {}) as object };
  }
  const sole = args[0];
  if (sole === undefined) {
    return { input: undefined, options: {} };
  }
  if (isQueryOptionsObject(sole)) {
    return { input: undefined, options: sole };
  }
  return { input: sole, options: {} };
}

function isQueryOptionsObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => QUERY_OPTION_KEYS.has(key));
}

/** `[key]`, plus the wire input when there is one. */
function deriveQueryKey(key: string, input: unknown): QueryKey {
  const wire = wireInput(input);
  return wire === null ? [key] : [key, wire];
}

type RuntimeProcedureHooks = {
  useQuery(...args: [unknown?, unknown?]): UseQueryResult<unknown, Error>;
  queryKey(...args: [unknown?]): QueryKey;
  useMutation(options?: unknown): UseMutationResult<unknown, Error, unknown>;
};

function procedureHooks(key: string): RuntimeProcedureHooks {
  return {
    queryKey(...args) {
      return deriveQueryKey(key, args[0]);
    },
    useQuery(...args) {
      const transport = useTransport();
      const { input, options } = readUseQueryArguments(args);
      // The derived fields come LAST — options can never override them.
      return useTanStackQuery({
        ...options,
        queryKey: deriveQueryKey(key, input),
        queryFn: () => transport.call(key, wireInput(input)),
      });
    },
    useMutation(options) {
      const transport = useTransport();
      return useTanStackMutation({
        ...(options as object | undefined),
        mutationFn: (variables: unknown) => transport.call(key, wireInput(variables)),
      });
    },
  };
}

function clientProxy(transport: RPCTransport): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      // "then" would make the client a thenable and hang `await client`.
      if (typeof property !== "string" || property === "then") {
        return undefined;
      }
      return (input?: unknown) => transport.call(property, wireInput(input));
    },
  });
}

/**
 * Bind the RPC's hook accessors ONCE — app/rpc.ts calls this at module
 * scope and every component imports the result (§5). The host
 * pluginId stays host-internal; `useRpc` supplies it at render.
 * Named createRPC, not useRPC: the factory is not a hook, only the
 * accessors it returns are.
 *
 * The runtime is one proxy — `RPC` is a type, so any string key yields
 * an accessor whose calls hit that key (no-input
 * calls send `null`, matching the SDK's `input ?? null`).
 */
export function createRPC<P extends RPCProcedures>(): RPCHooks<P> {
  const bundles = new Map<string, RuntimeProcedureHooks>();
  const useClient = (): Client<P> => {
    const transport = useTransport();
    return useMemo(() => clientProxy(transport) as unknown as Client<P>, [transport]);
  };
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      if (property === "useClient") {
        return useClient;
      }
      if (RESERVED_RPC_KEYS.includes(property)) {
        return undefined;
      }
      let bundle = bundles.get(property);
      if (bundle === undefined) {
        bundle = procedureHooks(property);
        bundles.set(property, bundle);
      }
      return bundle;
    },
  }) as RPCHooks<P>;
}

/**
 * The plugin's one cache. bb remounts panels on navigation, so a client
 * owned by a mount would drop every result each time. This one lives as
 * long as the plugin's app bundle. One retry keeps a failure visible
 * after seconds instead of the default ladder's half minute. Tests
 * reset it with `pluginQueryClient.clear()`.
 */
export const pluginQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

/**
 * The provider a plugin UI mounts at each registered component's root.
 * Every mount shares `pluginQueryClient` unless `client` overrides it.
 */
export function PluginQueryBoundary(props: {
  children?: ReactNode;
  client?: QueryClient;
}): ReactElement {
  return createElement(
    QueryClientProvider,
    { client: props.client ?? pluginQueryClient },
    props.children,
  );
}
