import { useRpc } from "@get-bb/plugin-sdk/app";
import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { z } from "zod";
import type { contract } from "../server/server.ts";
import { queryClient } from "./query.ts";

type Contract = typeof contract;
type Method = keyof Contract & string;

export type RPCInput<Name extends Method> = z.input<Contract[Name]["input"]>;
export type RPCOutput<Name extends Method> = z.output<Contract[Name]["output"]>;

/** The typed client for this plugin's RPC methods, resolved per render. */
export function useDotfilesRpc() {
  return useRpc<Contract>();
}

type Transport = { call(method: string, input: unknown): Promise<unknown> };

/**
 * The wire input for a call. No-input calls send `null`, matching the
 * SDK. Keys holding `undefined` are dropped, so `{ hostId }` with no
 * hostId passes a `.strict()` schema that only allows `hostId?`.
 */
function wireInput(input: unknown): unknown {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** `[method]` without input, else `[method, input]` with undefined-valued keys removed. */
export function queryKey<Name extends Method>(name: Name, input?: RPCInput<Name> | null): QueryKey {
  const wire = wireInput(input);
  return wire === null ? [name] : [name, wire];
}

type QueryOptions<Name extends Method> = Omit<
  UseQueryOptions<RPCOutput<Name>, Error, RPCOutput<Name>, QueryKey>,
  "queryKey" | "queryFn"
>;

/** Read `name` through the plugin's cache; the key is `queryKey(name, input)`. */
export function useRpcQuery<Name extends Method>(
  name: Name,
  input?: RPCInput<Name> | null,
  options?: QueryOptions<Name>,
): UseQueryResult<RPCOutput<Name>, Error> {
  const transport = useRpc() as unknown as Transport;
  return useQuery(
    {
      ...options,
      queryKey: queryKey(name, input),
      queryFn: () => transport.call(name, wireInput(input)) as Promise<RPCOutput<Name>>,
    },
    queryClient,
  );
}

type MutationOptions<Name extends Method> = Omit<
  UseMutationOptions<RPCOutput<Name>, Error, RPCInput<Name>>,
  "mutationFn"
>;

/** Call `name` as a mutation against the plugin's cache. */
export function useRpcMutation<Name extends Method>(
  name: Name,
  options?: MutationOptions<Name>,
): UseMutationResult<RPCOutput<Name>, Error, RPCInput<Name>> {
  const transport = useRpc() as unknown as Transport;
  return useMutation(
    {
      ...options,
      mutationFn: (variables) =>
        transport.call(name, wireInput(variables)) as Promise<RPCOutput<Name>>,
    },
    queryClient,
  );
}
