import { defineMutation } from "@bb-kit/core/rpc";
import { editTunnelSchema, tunnelWriteResultSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const editTunnel = defineMutation({
  input: editTunnelSchema,
  output: tunnelWriteResultSchema,
  execute: (ctx: CloudflareContext, input) => ctx.cloudflare.editTunnel(input),
});
