import {
  type StandardSchemaV1InferInput,
  type StandardSchemaV1InferOutput,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query";
import { useMemo } from "react";
import type { contract } from "../server/server.ts";

type Contract = typeof contract;
type Method = keyof Contract & string;
type Input<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;
type Output<M extends Method> = StandardSchemaV1InferOutput<Contract[M]["output"]>;

/**
 * The imperative client the bridge holds, one per mount: a method per RPC
 * over the SDK client's `call`. Written out rather than proxied, so a test
 * fake is a plain `{ api, interest }` object.
 */
export type WhiteboardRpcClient = {
  api(input: Input<"api">): Promise<Output<"api">>;
  claimOpen(input: Input<"claimOpen">): Promise<Output<"claimOpen">>;
  info(input: Input<"info">): Promise<Output<"info">>;
  interest(): Promise<Output<"interest">>;
  liveFile(input: Input<"liveFile">): Promise<Output<"liveFile">>;
};

/**
 * The wire input for a call: `null` for none, and keys holding `undefined`
 * dropped, so `{ threadId, after: undefined }` passes a strict schema.
 */
function wire<T>(input: T | null | undefined): T | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as T;
}

/** Stable for as long as the SDK's client is, so hubs and bridges keyed on it stay put. */
export function useWhiteboardRpc(): WhiteboardRpcClient {
  const client = useRpc<Contract>();
  return useMemo(
    () => ({
      api: (input) => client.call("api", wire(input)!),
      claimOpen: (input) => client.call("claimOpen", wire(input)!),
      info: (input) => client.call("info", wire(input)!),
      interest: () => client.call("interest"),
      liveFile: (input) => client.call("liveFile", wire(input)!),
    }),
    [client],
  );
}

/** `[method]` for no input, else `[method, input]` with undefined-valued keys removed. */
export function queryKey<M extends Method>(method: M, input?: Input<M> | null): QueryKey {
  const sent = wire(input);
  return sent === null ? [method] : [method, sent];
}

type QueryOptions<M extends Method> = Omit<
  UseQueryOptions<Output<M>, Error, Output<M>, QueryKey>,
  "queryKey" | "queryFn"
>;

/** TanStack `useQuery` over one RPC, keyed by `queryKey`, on the nearest provider's client. */
export function useRpcQuery<M extends Method>(
  method: M,
  input: Input<M>,
  options?: QueryOptions<M>,
): UseQueryResult<Output<M>, Error> {
  const client = useRpc<Contract>();
  const key = queryKey(method, input);
  const call = client.call as (method: M, input: unknown) => Promise<Output<M>>;
  return useQuery({ ...options, queryKey: key, queryFn: () => call(method, key[1] ?? null) });
}
