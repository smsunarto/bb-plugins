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

export type Contract = typeof contract;
export type Method = keyof Contract & string;
export type Input<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;
export type Output<M extends Method> = StandardSchemaV1InferOutput<Contract[M]["output"]>;

/** An input as a panel writes it: its client adds the panel's `threadId`. */
type PanelInput<M extends Method> = Omit<Input<M>, "threadId">;

/**
 * The client a panel holds: one method per RPC, each call carrying the
 * panel's thread, which scopes its scratchpad. Session inputs name the
 * canonical session id (`info.sessionId`), never the "scratchpad" alias. A
 * test fake is a plain object of the methods it uses.
 */
export type WhiteboardRpcClient = {
  [M in Method]: (input: PanelInput<M>) => Promise<Output<M>>;
};

/**
 * The wire input for a call: `null` for none, and keys holding `undefined`
 * dropped, so `{ threadId, after: undefined }` passes a strict schema and
 * is valid JSON for a live read's key.
 */
export function wire<T>(input: T | null | undefined): T | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as T;
}

/** Stable for as long as the SDK's client and the thread are, so bridges keyed on it stay put. */
export function useWhiteboardRpc(threadId: string | undefined): WhiteboardRpcClient {
  const client = useRpc<Contract>();
  return useMemo(() => {
    // SAFETY: `wire` only drops undefined keys from an input typed for `method`.
    const send = client.call as <M extends Method>(method: M, input: unknown) => Promise<Output<M>>;
    const call =
      <M extends Method>(method: M) =>
      (input: PanelInput<M>): Promise<Output<M>> =>
        send(method, wire({ ...input, threadId }));
    return {
      info: call("info"),
      claimOpen: call("claimOpen"),
      liveFile: call("liveFile"),
      sessions: call("sessions"),
      liveSession: call("liveSession"),
      sessionVersion: call("sessionVersion"),
      history: call("history"),
      stack: call("stack"),
      commits: call("commits"),
      map: call("map"),
      resource: call("resource"),
      progress: call("progress"),
      markProgress: call("markProgress"),
      copyContext: call("copyContext"),
      diffFiles: call("diffFiles"),
      file: call("file"),
      command: call("command"),
    } satisfies WhiteboardRpcClient;
  }, [client, threadId]);
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
