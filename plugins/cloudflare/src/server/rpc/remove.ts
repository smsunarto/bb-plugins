import { defineMutation } from "@bb-kit/core/rpc";
import { shareInputSchema, resultSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const remove = defineMutation({
  input: shareInputSchema,
  output: resultSchema,
  execute: (ctx: CloudflareContext, input) =>
    ctx.cloudflare.remove(input.id, input.expectedRevision),
});
