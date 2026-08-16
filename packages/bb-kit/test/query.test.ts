import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  defineOperation,
  defineOperationCatalog,
} from "../src/operations.js";

vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: vi.fn() }));

const {
  operationMutationOptions,
  operationQueryOptions,
} = await import("../src/query.js");

const catalog = defineOperationCatalog({
  get: {
    identity: "reports.get",
    wireMethod: "reports_get",
    operation: defineOperation({
      kind: "query",
      input: z.object({ id: z.string() }),
      exampleInput: { id: "R-1" },
      output: z.object({ value: z.string() }),
    }),
  },
  update: {
    identity: "reports.update",
    wireMethod: "reports_update",
    operation: defineOperation({
      kind: "command",
      risk: "mutating",
      input: z.object({ id: z.string(), value: z.string() }),
      exampleInput: { id: "R-1", value: "updated" },
      output: z.object({ value: z.string() }),
    }),
  },
});

describe("operation query options", () => {
  it("calls the locked wire method", async () => {
    const rpc = {
      call: vi.fn(async (_method: "reports_get", input: { id: string }) => ({
        value: input.id,
      })),
    };
    const options = operationQueryOptions({
      rpc,
      operation: catalog.get,
      input: { id: "R-1" },
      queryKey: ["reports", "R-1"] as const,
      staleTime: 30_000,
    });

    const result = await options.queryFn?.({} as never);
    expect(result).toEqual({ value: "R-1" });
    expect(options.staleTime).toBe(30_000);
    expect(rpc.call).toHaveBeenCalledWith("reports_get", { id: "R-1" });
  });

  it("rejects commands at the query boundary", () => {
    expect(() => operationQueryOptions({
      rpc: { call: async () => ({ value: "unexpected" }) },
      operation: catalog.update,
      input: { id: "R-1", value: "unexpected" },
      queryKey: ["reports", "R-1"] as const,
    } as never)).toThrow(/requires a query operation/);
  });

  it("invalidates declared keys after a successful command", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rpc = {
      call: vi.fn(
        async (
          _method: "reports_update",
          input: { id: string; value: string },
        ) => ({ value: input.value }),
      ),
    };
    const options = operationMutationOptions({
      rpc,
      operation: catalog.update,
      queryClient,
      invalidate: ({ input }) => [
        ["reports"] as const,
        ["reports", input.id] as const,
      ],
    });

    const input = { id: "R-1", value: "updated" };
    const result = await options.mutationFn?.(input, {} as never);
    await options.onSuccess?.(result!, input, undefined, {} as never);

    expect(rpc.call).toHaveBeenCalledWith("reports_update", input);
    expect(invalidate).toHaveBeenNthCalledWith(1, {
      queryKey: ["reports"],
    });
    expect(invalidate).toHaveBeenNthCalledWith(2, {
      queryKey: ["reports", "R-1"],
    });
  });

  it("rejects queries at the mutation boundary", () => {
    expect(() => operationMutationOptions({
      rpc: { call: async () => ({ value: "unexpected" }) },
      operation: catalog.get,
      queryClient: new QueryClient(),
      invalidate: false,
    } as never)).toThrow(/requires a command operation/);
  });
});
