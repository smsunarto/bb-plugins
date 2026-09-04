import { createRPC } from "@bb-kit/core/rpc/query";
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from "@bb-kit/core/rpc";
import type plugin from "../server/server.ts";

export const rpc = createRPC<(typeof plugin)["rpc"]>();

type Procedures = (typeof plugin)["rpc"];

export type RPCInput<Name extends keyof Procedures> = Procedures[Name] extends {
  input: infer Input extends StandardSchemaV1;
}
  ? SchemaInput<Input>
  : never;

export type RPCOutput<Name extends keyof Procedures> = Procedures[Name] extends {
  output: infer Output extends StandardSchemaV1;
}
  ? SchemaOutput<Output>
  : never;
