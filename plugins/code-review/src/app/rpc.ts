import { useContext, useEffect } from "react";
import { QueryClientContext, useMutation, useQuery } from "@tanstack/react-query";
import type { QueryKey, UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { contract } from "../server/server.ts";
import { installLocalCache } from "./local-cache.ts";
import { queryClient } from "./query.ts";

// Hydrate before any query observer or status gate mounts. The content script
// owns the lifetime, so a plugin reload removes the old subscriber and listeners.
let disposeCache: (() => void) | undefined;
function startCache() {
  if (disposeCache) return;
  try {
    disposeCache = installLocalCache(queryClient, window.localStorage);
  } catch {
    /* no browser storage */
  }
}
startCache();
export function mountLocalCache(): () => void {
  startCache();
  return () => {
    disposeCache?.();
    disposeCache = undefined;
  };
}

type Contract = typeof contract;
export type Method = keyof Contract & string;
export type Input<M extends Method> = z.input<Contract[M]["input"]>;
export type Output<M extends Method> = z.output<Contract[M]["output"]>;
/** The typed client for this plugin's RPC methods, resolved per render. */
export type Client = ReturnType<typeof useRpc<Contract>>;
type Transport = { call(method: string, input: unknown): Promise<unknown> };

export function useCodeReviewRpc(): Client {
  return useRpc<Contract>();
}

/** The wire input: `null` for none, and no keys holding `undefined`, so strict schemas accept it. */
function wireInput(input: unknown): unknown {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** `[method]`, plus the wire input when there is one. The persisted cache and invalidations match on it. */
export function queryKey<M extends Method>(method: M, input?: Input<M> | null): QueryKey {
  const wire = wireInput(input);
  return wire === null ? [method] : [method, wire];
}

/**
 * Hook slots such as a nav panel's badge run outside any `QueryClientProvider`.
 * There the shared client is mounted by hand, so its reconnect and focus listeners stay on.
 */
function useMountedQueryClient() {
  const provided = useContext(QueryClientContext) !== undefined;
  useEffect(() => {
    if (provided) return;
    queryClient.mount();
    return () => queryClient.unmount();
  }, [provided]);
  return queryClient;
}

export function useRpcQuery<M extends Method>(
  method: M,
  input: Input<M> | null,
  options?: Omit<UseQueryOptions<Output<M>, Error, Output<M>, QueryKey>, "queryKey" | "queryFn">,
) {
  const transport = useCodeReviewRpc() as unknown as Transport;
  const client = useMountedQueryClient();
  return useQuery(
    {
      ...options,
      queryKey: queryKey(method, input),
      queryFn: () => transport.call(method, wireInput(input)) as Promise<Output<M>>,
    },
    client,
  );
}

export function useRpcMutation<M extends Method>(
  method: M,
  options?: Omit<UseMutationOptions<Output<M>, Error, Input<M>>, "mutationFn">,
) {
  const transport = useCodeReviewRpc() as unknown as Transport;
  const client = useMountedQueryClient();
  return useMutation(
    {
      ...options,
      mutationFn: (variables: Input<M>) =>
        transport.call(method, wireInput(variables)) as Promise<Output<M>>,
    },
    client,
  );
}
