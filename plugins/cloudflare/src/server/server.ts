import { definePlugin } from "@bb-kit/core/plugin";
import { overview } from "./rpc/overview.ts";
import { create } from "./rpc/create.ts";
import { update } from "./rpc/update.ts";
import { start } from "./rpc/start.ts";
import { stop } from "./rpc/stop.ts";
import { remove } from "./rpc/remove.ts";
import { status } from "./command/status.ts";
import { shares } from "./tools/shares.ts";
import { setupService } from "./lib/service.ts";
import { oauthStatus } from "./rpc/oauth-status.ts";
import { oauthConnect } from "./rpc/oauth-connect.ts";
import { oauthDisconnect } from "./rpc/oauth-disconnect.ts";
export default definePlugin({
  pluginId: "cloudflare",
  rpc: {
    overview,
    create,
    update,
    start,
    stop,
    remove,
    oauthStatus,
    oauthConnect,
    oauthDisconnect,
  },
  command: { status },
  agents: { tools: { shares } },
  setup(bb) {
    setupService(bb);
  },
});
