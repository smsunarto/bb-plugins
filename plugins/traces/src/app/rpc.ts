import {
  useRpc,
  type StandardSchemaV1InferInput,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { contract } from "../server/server.ts";

type Contract = typeof contract;
type Method = Extract<keyof Contract, string>;
type Input<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;
type Output<M extends Method> = StandardSchemaV1InferOutput<Contract[M]["output"]>;

/** The typed client for this plugin's RPC methods, resolved per render. */
export function useTracesRpc() {
  return useRpc<Contract>();
}

/** The wire input: keys holding `undefined` are dropped, so strict schemas and keys agree. */
function wireInput(input: unknown): unknown {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** `[method]` without input, else `[method, input]`; cache writes and invalidations match on these. */
export function queryKey<M extends Method>(method: M, input?: Input<M> | null): QueryKey {
  const wire = wireInput(input);
  return wire === null ? [method] : [method, wire];
}

/** The SDK client behind one loose seam: a generic method cannot satisfy its per-method overloads. */
type Transport = { call(method: Method, input: unknown): Promise<unknown> };

export function useRpcQuery<M extends Method>(
  method: M,
  input: Input<M>,
  options?: Omit<UseQueryOptions<Output<M>, Error, Output<M>, QueryKey>, "queryKey" | "queryFn">,
) {
  const transport = useRpc<Contract>() as unknown as Transport;
  return useQuery({
    ...options,
    queryKey: queryKey(method, input),
    queryFn: () => transport.call(method, wireInput(input)) as Promise<Output<M>>,
  });
}

export function useRpcMutation<M extends Method>(
  method: M,
  options?: Omit<UseMutationOptions<Output<M>, Error, Input<M>>, "mutationFn">,
) {
  const transport = useRpc<Contract>() as unknown as Transport;
  return useMutation({
    ...options,
    mutationFn: (input: Input<M>) => transport.call(method, wireInput(input)) as Promise<Output<M>>,
  });
}
