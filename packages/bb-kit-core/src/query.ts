import { createElement, useEffect, useMemo, useRef } from "react";
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
import type { AnyRPC } from "./internal/procedure.ts";
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from "./internal/standard-schema.ts";
import type { ClientFor } from "./rpc.ts";
import { wireName } from "./internal/wire-name.ts";

/** Public surface of `@bb-kit/core/query` (§1, §5). */

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
 * The per-procedure accessor, discriminated on the `kind` field (§5):
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

type RPCHooks<R extends AnyRPC> = {
  readonly [K in keyof R["procedures"]]: ProcedureHooks<R["procedures"][K]>;
} & {
  /** The imperative escape hatch (§5): the typed client, per render. */
  useClient(): ClientFor<R>;
};

type RPCTransport = { call(method: string, input?: unknown): Promise<unknown> };

/** The SDK client behind one structural seam, resolved at render time. */
function useTransport(): RPCTransport {
  return useRpc() as unknown as RPCTransport;
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

/** §5 derivation: `[namespace, key]`, plus the input when one is given. */
function deriveQueryKey(namespace: string, key: string, input: unknown): QueryKey {
  return input === undefined ? [namespace, key] : [namespace, key, input];
}

type RuntimeProcedureHooks = {
  useQuery(...args: [unknown?, unknown?]): UseQueryResult<unknown, Error>;
  queryKey(...args: [unknown?]): QueryKey;
  useMutation(options?: unknown): UseMutationResult<unknown, Error, unknown>;
};

function procedureHooks(namespace: string, key: string): RuntimeProcedureHooks {
  const wire = wireName(namespace, key);
  return {
    queryKey(...args) {
      return deriveQueryKey(namespace, key, args[0]);
    },
    useQuery(...args) {
      const transport = useTransport();
      const { input, options } = readUseQueryArguments(args);
      // The derived fields come LAST — options can never override them.
      return useTanStackQuery({
        ...options,
        queryKey: deriveQueryKey(namespace, key, input),
        queryFn: () => transport.call(wire, input ?? null),
      });
    },
    useMutation(options) {
      const transport = useTransport();
      return useTanStackMutation({
        ...(options as object | undefined),
        mutationFn: (variables: unknown) => transport.call(wire, variables ?? null),
      });
    },
  };
}

function clientProxy(namespace: string, transport: RPCTransport): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      // "then" would make the client a thenable and hang `await client`.
      if (typeof property !== "string" || property === "then") {
        return undefined;
      }
      return (input?: unknown) => transport.call(wireName(namespace, property), input ?? null);
    },
  });
}

/**
 * Bind the RPC's hook accessors to their namespace ONCE — ui/rpc.ts
 * calls this at module scope and every component imports the result
 * (§5). The pluginId is host-internal; binding here is what keeps it
 * out of every call site. Named createRPC, not useRPC: the factory is
 * not a hook, only the accessors it returns are.
 *
 * The runtime is one proxy — `RPC` is a type, so any string key yields
 * an accessor whose calls hit `wireName(namespace, key)` (no-input
 * calls send `null`, matching the SDK's `input ?? null`).
 */
export function createRPC<R extends AnyRPC>(namespace: R["namespace"]): RPCHooks<R> {
  const bundles = new Map<string, RuntimeProcedureHooks>();
  const useClient = (): ClientFor<R> => {
    const transport = useTransport();
    return useMemo(() => clientProxy(namespace, transport) as unknown as ClientFor<R>, [transport]);
  };
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      if (property === "useClient") {
        return useClient;
      }
      let bundle = bundles.get(property);
      if (bundle === undefined) {
        bundle = procedureHooks(namespace, property);
        bundles.set(property, bundle);
      }
      return bundle;
    },
  }) as RPCHooks<R>;
}

/**
 * The QueryClientProvider a plugin UI mounts once at its root (§5 —
 * the host does not shim @tanstack/react-query, so the plugin owns its
 * QueryClient). Lazily creates one client per mount and clears it on
 * unmount; a `client` prop overrides ownership — the caller's client is
 * used as-is and never cleared.
 */
export function PluginQueryBoundary(props: {
  children?: ReactNode;
  client?: QueryClient;
}): ReactElement {
  const owned = useRef<QueryClient | undefined>(undefined);
  const mounted = useRef(false);
  const external = props.client;
  const client = external ?? owned.current ?? (owned.current = new QueryClient());
  useEffect(() => {
    if (external !== undefined) {
      return undefined;
    }
    const ownedClient = owned.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Child observers detach LATER in this same unmount commit and
      // re-schedule gcTime timers on the queries and mutations they
      // release, so sweep once, AFTER the commit — clearing here first
      // would orphan a settled mutation the microtask can no longer
      // reach. QueryCache.clear() destroys each query's gc timer, but
      // MutationCache.clear() only empties its map (verified in
      // @tanstack/query-core 5.101 source), so mutations are destroyed
      // explicitly — otherwise a five-minute timer outlives the
      // boundary and test processes cannot exit.
      queueMicrotask(() => {
        // A StrictMode dev double mount remounts the SAME owned client
        // before this microtask runs — sweeping then would silently
        // cancel the live panel's first in-flight query, freezing it on
        // isPending. Only sweep when the boundary is still unmounted.
        if (mounted.current || ownedClient === undefined) {
          return;
        }
        for (const mutation of ownedClient.getMutationCache().getAll()) {
          mutation.destroy();
        }
        ownedClient.clear();
      });
    };
  }, [external]);
  return createElement(QueryClientProvider, { client }, props.children);
}
