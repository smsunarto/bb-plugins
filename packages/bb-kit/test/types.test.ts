import type { BbPluginApi } from "@bb/plugin-sdk";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  defineOperation,
  defineOperationCatalog,
  registerOperations,
  type OperationHost,
} from "../src/operations.js";
import {
  operationMutationOptions,
  operationQueryOptions,
} from "../src/query.js";

const catalog = defineOperationCatalog({
  get: {
    identity: "types.get",
    wireMethod: "types_get",
    operation: defineOperation({
      kind: "query",
      input: z.object({ id: z.string() }),
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
