import { defineMutation } from "@bb-kit/core/rpc";
import { createSchema, resultSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const create = defineMutation({
  input: createSchema,
  output: resultSchema,
  execute: (ctx: CloudflareContext, input) => ctx.cloudflare.create(input),
});
