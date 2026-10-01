import type { Context } from "@bb-kit/core/plugin";
import { defineMutation } from "@bb-kit/core/rpc";
import { apiRequest, apiResponse } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardServices } from "../../shared/contracts/engine.ts";

/** The app's tunnel into the in-process review API (design §3.2). Owned by WP7. */
export const api = defineMutation({
  input: apiRequest,
  output: apiResponse,
  async execute(ctx: Context<Pick<WhiteboardServices, "engine">>, input) {
    return ctx.engine.request(input);
  },
});
