import { defineMutation } from "@bb-kit/core/rpc";
import { updateSchema, resultSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const update = defineMutation({
  input: updateSchema,
  output: resultSchema,
  execute: (ctx: CloudflareContext, input) =>
    ctx.cloudflare.update(input.id, input.spec, input.expectedRevision),
});
