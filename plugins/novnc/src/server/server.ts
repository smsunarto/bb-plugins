import { definePlugin } from "@bb-kit/core/plugin";
import { getNovncStatus } from "./rpc/get-novnc-status.ts";
import { createRemoteSessionResponse } from "./remote-session.ts";

export default definePlugin({
  pluginId: "novnc",
  rpc: { getNovncStatus },
  setup(bb) {
    bb.http.route(
      "POST",
      "/remote-session",
      (context) =>
        createRemoteSessionResponse(bb, {
          forwardedHost: context.req.header("x-forwarded-host"),
          gateAuth: context.req.header("x-bb-gate-auth"),
          host: context.req.header("host"),
          requestUrl: context.req.url,
        }),
      { auth: "local" },
    );
  },
});
