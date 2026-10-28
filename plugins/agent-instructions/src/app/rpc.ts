import { useRpc } from "@get-bb/plugin-sdk/app";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import type { StandardSchemaV1InferInput, StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk";
import type { contract } from "../server/server.ts";

type Contract = typeof contract;
type Method = keyof Contract & string;
type Input<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;
type Output<M extends Method> = StandardSchemaV1InferOutput<Contract[M]["output"]>;

type QueryOptions<M extends Method> = Omit<
  UseQueryOptions<Output<M>, Error, Output<M>, QueryKey>,
  "queryKey" | "queryFn"
>;
type MutationOptions<M extends Method> = Omit<
  UseMutationOptions<Output<M>, Error, Input<M>>,
  "mutationFn"
>;

/** The typed client for this plugin's RPC methods, resolved per render. */
export function useAgentInstructionsRpc() {
  return useRpc<Contract>();
}

/**
 * The wire input for a call. No-input calls send `null`, matching the SDK.
 * Keys holding `undefined` are dropped, so `{ id, cursor }` with no cursor
 * passes a `.strict()` schema that only allows `cursor?`.
 */
function wire(input: unknown): unknown {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** `[method]`, plus the wire input when there is one. */
export function queryKey<M extends Method>(method: M, input?: Input<M>): QueryKey {
  const sent = wire(input);
  return sent === null ? [method] : [method, sent];
}

export function useRpcQuery<M extends Method>(
  method: M,
  input: Input<M>,
  options?: QueryOptions<M>,
): UseQueryResult<Output<M>, Error> {
  const client = useAgentInstructionsRpc();
  return useQuery({
    ...options,
    queryKey: queryKey(method, input),
    queryFn: () => client.call(method, wire(input) as never) as Promise<Output<M>>,
  });
}

export function useRpcMutation<M extends Method>(
  method: M,
  options?: MutationOptions<M>,
): UseMutationResult<Output<M>, Error, Input<M>> {
  const client = useAgentInstructionsRpc();
  return useMutation({
    ...options,
    mutationFn: (variables: Input<M>) =>
      client.call(method, wire(variables) as never) as Promise<Output<M>>,
  });
}
