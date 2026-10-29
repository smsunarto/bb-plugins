import type { StandardSchemaV1InferInput, StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import type { contract } from "../server/server.ts";
import { queryClient } from "./query.ts";

type Contract = typeof contract;
export type Method = keyof Contract & string;
export type RpcInput<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;
export type RpcOutput<M extends Method> = StandardSchemaV1InferOutput<Contract[M]["output"]>;
export type QueryOptions<Out> = Omit<
  UseQueryOptions<Out, Error, Out, QueryKey>,
  "queryKey" | "queryFn"
>;
type MutationOptions<M extends Method> = Omit<
  UseMutationOptions<RpcOutput<M>, Error, RpcInput<M>>,
  "mutationFn"
>;

/** The typed client for this plugin's RPC methods, resolved per render. */
export function useGitButlerRpc() {
  return useRpc<Contract>();
}

/** The wire input: `null` for none, and no key holding `undefined`, so `.strict()` inputs pass. */
export function wireInput(input: unknown): unknown {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** `[method]`, plus the wire input when there is one. Persisted caches match on this shape. */
export function rpcQueryKey<M extends Method>(method: M, input?: RpcInput<M>): QueryKey {
  const wire = wireInput(input);
  return wire === null ? [method] : [method, wire];
}

/** One call of an RPC method, with its input put on the wire and its answer typed by the contract. */
export function callRpc<M extends Method>(
  rpc: ReturnType<typeof useGitButlerRpc>,
  method: M,
  input: RpcInput<M>,
): Promise<RpcOutput<M>> {
  return rpc.call(method, wireInput(input) as never) as Promise<RpcOutput<M>>;
}

/** A read of one RPC method on the plugin's shared cache. */
export function useRpcQuery<M extends Method>(
  method: M,
  input: RpcInput<M>,
  options?: QueryOptions<RpcOutput<M>>,
): UseQueryResult<RpcOutput<M>, Error> {
  const rpc = useGitButlerRpc();
  const queryFn = () => callRpc(rpc, method, input);
  return useQuery({ ...options, queryKey: rpcQueryKey(method, input), queryFn }, queryClient);
}

/** A write through one RPC method on the plugin's shared cache. */
export function useRpcMutation<M extends Method>(
  method: M,
  options?: MutationOptions<M>,
): UseMutationResult<RpcOutput<M>, Error, RpcInput<M>> {
  const rpc = useGitButlerRpc();
  const mutationFn = (variables: RpcInput<M>) => callRpc(rpc, method, variables);
  return useMutation({ ...options, mutationFn }, queryClient);
}
