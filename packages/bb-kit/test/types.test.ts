import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  defineOperation,
  defineOperationCatalog,
  registerOperations,
  type OperationDescriptor,
  type OperationHost,
} from "../src/operations.js";
import { operationMutationOptions, operationQueryOptions, useOperationRpc } from "../src/query.js";

const catalog = defineOperationCatalog({
  get: {
    identity: "types.get",
    wireMethod: "types_get",
    operation: defineOperation({
      kind: "query",
      input: z.object({ id: z.string() }),
      exampleInput: { id: "A-1" },
      output: z.object({ count: z.number() }),
    }),
  },
});

const commandCatalog = defineOperationCatalog({
  update: {
    identity: "types.update",
    wireMethod: "types_update",
    operation: defineOperation({
      kind: "command",
      risk: "mutating",
      input: z.object({ id: z.string() }),
      exampleInput: { id: "A-1" },
      output: z.object({ count: z.number() }),
    }),
  },
});

function structuralCompatibility(bb: BbPluginApi): void {
  const host: OperationHost = bb;
  registerOperations(host, catalog, {
    get: ({ id }) => ({ count: id.length }),
  });
}

void structuralCompatibility;

registerOperations({ rpc: { register() {} } }, catalog, {
  // @ts-expect-error handler input is the parsed operation input
  get: ({ missing }: { missing: number }) => ({ count: missing }),
});

registerOperations({ rpc: { register() {} } }, catalog, {
  // @ts-expect-error handler output must satisfy the operation output schema
  get: ({ id }) => ({ count: id }),
});

function operationKindCompatibility(queryClient: QueryClient): void {
  const rpc = {
    call: async (_method: string, input: { id: string }) => ({
      count: input.id.length,
    }),
  };
  operationQueryOptions({
    rpc,
    // @ts-expect-error commands must not run through retried query options
    operation: commandCatalog.update,
    input: { id: "A-1" },
    queryKey: ["types", "A-1"],
  });
  operationMutationOptions({
    rpc,
    // @ts-expect-error queries must not run through mutation options
    operation: catalog.get,
    queryClient,
    invalidate: false,
  });
}

void operationKindCompatibility;

function operationRpcCompatibility(): void {
  const rpc = useOperationRpc(catalog);
  const result: Promise<{ count: number }> = rpc.call("types_get", { id: "A-1" });
  void result;
  // @ts-expect-error input comes from the selected catalog method
  rpc.call("types_get", { missing: true });
  // @ts-expect-error unknown methods are rejected
  rpc.call("types_missing", { id: "A-1" });
}

void operationRpcCompatibility;

const typeInput = z.string();
const typeOutput = z.null();
const invalidExample: OperationDescriptor<typeof typeInput, typeof typeOutput> = {
  kind: "query",
  input: typeInput,
  // @ts-expect-error example input must satisfy the schema input
  exampleInput: 123,
  output: typeOutput,
};

// @ts-expect-error required-input operations cannot omit exampleInput
const missingExample: OperationDescriptor<typeof typeInput, typeof typeOutput> = {
  kind: "query",
  input: typeInput,
  output: typeOutput,
};

void invalidExample;
void missingExample;
