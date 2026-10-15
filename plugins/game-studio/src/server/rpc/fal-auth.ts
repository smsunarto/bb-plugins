import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { falAuthAction, falAuthStatus, type FalOAuthContext } from "../lib/fal-oauth.ts";
export const falAuth = defineMutation({
  input: z.strictObject({ action: falAuthAction }),
  output: falAuthStatus,
  execute: (ctx: FalOAuthContext, input) => ctx.falOAuth.execute(input.action),
});
