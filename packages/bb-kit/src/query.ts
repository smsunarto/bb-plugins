import { createElement, useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import {
  QueryClient,
  QueryClientProvider,
  mutationOptions,
  queryOptions,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  BoundOperation,
  OperationBinding,
  RpcContract,
} from "./operations.js";
import type { SchemaInput, SchemaOutput } from "./standard-schema.js";

type AnyBoundOperation = BoundOperation<OperationBinding>;
type BoundQueryOperation = AnyBoundOperation & { readonly kind: "query" };
type BoundCommandOperation = AnyBoundOperation & { readonly kind: "command" };

export interface OperationRpcClient<
  Method extends string,
  Input,
  Output,
> {
  call(method: Method, input: Input): Promise<Output>;
}

export type OperationRpcClientFor<
  Catalog extends { readonly rpcContract: RpcContract },
> = {
  call<Method extends Extract<keyof Catalog["rpcContract"], string>>(
    method: Method,
    input: SchemaInput<Catalog["rpcContract"][Method]["input"]>,
  ): Promise<SchemaOutput<Catalog["rpcContract"][Method]["output"]>>;
};

/** Hide bb 0.37's narrower Standard Schema generic at one catalog-owned seam. */
export function useOperationRpc<
  const Catalog extends { readonly rpcContract: RpcContract },
>(catalog: Catalog): OperationRpcClientFor<Catalog> {
  void catalog;
  return useRpc() as unknown as OperationRpcClientFor<Catalog>;
}

type ClientInput<Operation extends AnyBoundOperation> = SchemaInput<
  Operation["input"]
>;
type ClientOutput<Operation extends AnyBoundOperation> = SchemaOutput<
  Operation["output"]
>;

export type OperationQueryOptions<
  Operation extends BoundQueryOperation,
  Key extends QueryKey,
> = Omit<
  UseQueryOptions<
    ClientOutput<Operation>,
    Error,
    ClientOutput<Operation>,
    Key
  >,
  "queryFn" | "queryKey"
> & {
  readonly rpc: OperationRpcClient<
    Operation["wireMethod"],
    ClientInput<Operation>,
    ClientOutput<Operation>
  >;
  readonly operation: Operation;
  readonly input: ClientInput<Operation>;
  readonly queryKey: Key;
};

/** Convert one operation into native TanStack Query options. */
export function operationQueryOptions<
  const Operation extends BoundQueryOperation,
  const Key extends QueryKey,
>(configuration: OperationQueryOptions<Operation, Key>) {
  const { rpc, operation, input, queryKey, ...nativeOptions } = configuration;
  if (operation.kind !== "query") {
    throw new TypeError("operationQueryOptions requires a query operation");
  }
  return queryOptions({
    ...nativeOptions,
    queryKey,
    queryFn: () => rpc.call(operation.wireMethod, input),
  });
}

export interface MutationInvalidationContext<
  Operation extends BoundCommandOperation,
> {
  readonly input: ClientInput<Operation>;
  readonly result: ClientOutput<Operation>;
}

type Invalidation<Operation extends BoundCommandOperation> =
  | false
  | ((
      context: MutationInvalidationContext<Operation>,
    ) => readonly QueryKey[]);

export type OperationMutationOptions<
  Operation extends BoundCommandOperation,
  Context = unknown,
> = Omit<
  UseMutationOptions<
    ClientOutput<Operation>,
    Error,
    ClientInput<Operation>,
    Context
  >,
  "mutationFn" | "onSuccess"
> & {
  readonly rpc: OperationRpcClient<
    Operation["wireMethod"],
    ClientInput<Operation>,
    ClientOutput<Operation>
  >;
  readonly operation: Operation;
  readonly queryClient: QueryClient;
  readonly invalidate: Invalidation<Operation>;
  readonly onSuccess?: (
    data: ClientOutput<Operation>,
    variables: ClientInput<Operation>,
    onMutateResult: Context,
    context: Parameters<
      NonNullable<
        UseMutationOptions<
          ClientOutput<Operation>,
          Error,
          ClientInput<Operation>,
          Context
        >["onSuccess"]
      >
    >[3],
  ) => unknown | Promise<unknown>;
};

/**
 * Convert one command into native mutation options. Invalidation is mandatory
 * unless the caller explicitly passes false.
 */
export function operationMutationOptions<
  const Operation extends BoundCommandOperation,
  Context = unknown,
>(configuration: OperationMutationOptions<Operation, Context>) {
  const {
    rpc,
    operation,
    queryClient,
    invalidate,
    onSuccess,
    ...nativeOptions
  } = configuration;
  if (operation.kind !== "command") {
    throw new TypeError("operationMutationOptions requires a command operation");
  }
  return mutationOptions({
    ...nativeOptions,
    mutationFn: (input: ClientInput<Operation>) =>
      rpc.call(operation.wireMethod, input),
    async onSuccess(data, variables, onMutateResult, context) {
      if (invalidate !== false) {
        const keys = invalidate({ input: variables, result: data });
        await Promise.all(
          keys.map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        );
      }
      await onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}

export interface PluginQueryBoundaryProps {
  readonly children: ReactNode;
  readonly client?: QueryClient;
}

/** Own one QueryClient for one mounted plugin application generation. */
export function PluginQueryBoundary({
  children,
  client,
}: PluginQueryBoundaryProps) {
  const [queryClient] = useState(() => client ?? new QueryClient());
  const ownsClient = client === undefined;

  useEffect(
    () => () => {
      if (ownsClient) queryClient.clear();
    },
    [ownsClient, queryClient],
  );

  return createElement(QueryClientProvider, { client: queryClient }, children);
}

export { QueryClient };
export type { QueryKey };
