import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineOperation,
  defineOperationCatalog,
  noInput,
  registerOperations,
  type OperationHost,
  type RpcContract,
  type RpcHandlers,
} from "../src/operations.js";

const getOperation = defineOperation({
  kind: "query",
  input: z.object({ id: z.string() }),
  exampleInput: { id: "A-1" },
  output: z.object({ value: z.string() }),
});

const approveOperation = defineOperation({
  kind: "command",
  risk: "destructive",
  input: z.object({ id: z.string() }),
  exampleInput: { id: "A-1" },
  output: z.object({ approved: z.boolean() }),
});

const catalog = defineOperationCatalog({
  get: {
    identity: "approvals.get",
    wireMethod: "approvals_get",
    operation: getOperation,
  },
  approve: {
    identity: "approvals.approve",
    wireMethod: "approvals_approve",
    operation: approveOperation,
  },
});

describe("operation catalogs", () => {
  it("uses one frozen, null-only no-input schema", async () => {
    expect(Object.isFrozen(noInput)).toBe(true);
    expect(Object.isFrozen(noInput["~standard"])).toBe(true);
    await expect(Promise.resolve(noInput["~standard"].validate(null))).resolves.toEqual({
      value: null,
    });
    await expect(Promise.resolve(noInput["~standard"].validate({}))).resolves.toEqual({
      issues: [{ message: "expected no input" }],
    });
    expect(
      defineOperation({
        kind: "query",
        input: noInput,
        output: z.null(),
      }).input,
    ).toBe(noInput);
  });

  it("treats structural null schemas as required input and rejects invalid examples", () => {
    expect(
      defineOperation({
        kind: "query",
        input: z.null(),
        exampleInput: null,
        output: z.null(),
      }).input,
    ).not.toBe(noInput);
    expect(() =>
      defineOperation({
        kind: "query",
        input: z.string(),
        output: z.null(),
      } as never),
    ).toThrow(/must declare exampleInput/);
    expect(() =>
      defineOperation({
        kind: "query",
        input: noInput,
        exampleInput: null,
        output: z.null(),
      } as never),
    ).toThrow(/must not declare exampleInput/);
    expect(() =>
      defineOperation({
        kind: "query",
        input: z.unknown(),
        exampleInput: new Date(),
        output: z.null(),
      } as never),
    ).toThrow(/finite, acyclic JSON/);
  });

  it("builds a native Standard Schema RPC contract", () => {
    expect(Object.keys(catalog.rpcContract)).toEqual(["approvals_get", "approvals_approve"]);
    expect(catalog.get.identity).toBe("approvals.get");
    expect(catalog.approve.wireMethod).toBe("approvals_approve");
  });

  it("rekeys local handlers to locked wire methods", async () => {
    let registeredContract: RpcContract | undefined;
    let registeredHandlers: RpcHandlers<RpcContract> | undefined;
    const host: OperationHost = {
      rpc: {
        register<Contract extends RpcContract>(
          contract: Contract,
          handlers: RpcHandlers<Contract>,
        ) {
          registeredContract = contract;
          registeredHandlers = handlers;
        },
      },
    };

    registerOperations(host, catalog, {
      get: ({ id }) => ({ value: id }),
      approve: async ({ id }) => ({ approved: id.length > 0 }),
    });

    expect(registeredContract).toBe(catalog.rpcContract);
    await expect(
      Promise.resolve(registeredHandlers?.approvals_get?.({ id: "A-1" })),
    ).resolves.toEqual({ value: "A-1" });
    await expect(registeredHandlers?.approvals_approve?.({ id: "A-1" })).resolves.toEqual({
      approved: true,
    });
  });

  it("rejects illegal and colliding wire methods before registration", () => {
    expect(() =>
      defineOperationCatalog({
        bad: {
          identity: "approvals.bad",
          wireMethod: "approvals.bad",
          operation: getOperation,
        },
      }),
    ).toThrow(/RPC method/);

    expect(() =>
      defineOperationCatalog({
        first: {
          identity: "approvals.first",
          wireMethod: "approvals_same",
          operation: getOperation,
        },
        second: {
          identity: "approvals.second",
          wireMethod: "approvals_same",
          operation: getOperation,
        },
      }),
    ).toThrow(/duplicate RPC method/);
  });

  it("rejects missing and extra handlers", () => {
    const host: OperationHost = {
      rpc: { register() {} },
    };
    expect(() =>
      registerOperations(host, catalog, {
        get: ({ id }: { id: string }) => ({ value: id }),
      } as never),
    ).toThrow(/has no handler/);
    expect(() =>
      registerOperations(host, catalog, {
        get: ({ id }: { id: string }) => ({ value: id }),
        approve: ({ id }: { id: string }) => ({ approved: id.length > 0 }),
        extra: () => ({}),
      } as never),
    ).toThrow(/has no operation descriptor/);
  });
});
