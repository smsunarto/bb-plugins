import { defineMutation } from "@bb-kit/core/rpc";
import { editTunnelSchema, tunnelWriteResultSchema } from "../../shared/schema.ts";
import { getService } from "../lib/service.ts";
export const editTunnel = defineMutation({
  input: editTunnelSchema,
  output: tunnelWriteResultSchema,
  execute: (ctx, input) => getService(ctx.bb).editTunnel(input),
});
