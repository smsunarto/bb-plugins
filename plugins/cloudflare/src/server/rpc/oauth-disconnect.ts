import { defineMutation } from "@bb-kit/core/rpc";
import { oauthDisconnectSchema } from "../../shared/schema.ts";
import { getOAuth } from "../lib/service.ts";
export const oauthDisconnect = defineMutation({
  output: oauthDisconnectSchema,
  execute: (ctx) => getOAuth(ctx.bb).disconnect(),
});
