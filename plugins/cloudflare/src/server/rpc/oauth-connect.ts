import { defineMutation } from "@bb-kit/core/rpc";
import { oauthConnectSchema } from "../../shared/schema.ts";
import { getOAuth } from "../lib/service.ts";
export const oauthConnect = defineMutation({
  output: oauthConnectSchema,
  execute: (ctx) => getOAuth(ctx.bb).connect(),
});
