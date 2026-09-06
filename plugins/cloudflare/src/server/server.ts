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
import { setupQuickShares } from "./lib/quick-shares.ts";
import { quickList } from "./rpc/quick-list.ts";
import { quickCreate } from "./rpc/quick-create.ts";
import { quickStart } from "./rpc/quick-start.ts";
import { quickStop } from "./rpc/quick-stop.ts";
import { quickRemove } from "./rpc/quick-remove.ts";
import { oauthStatus } from "./rpc/oauth-status.ts";
import { oauthConnect } from "./rpc/oauth-connect.ts";
import { oauthDisconnect } from "./rpc/oauth-disconnect.ts";
import { tunnelDetails } from "./rpc/tunnel-details.ts";
import { editTunnel } from "./rpc/edit-tunnel.ts";
export default definePlugin({
  pluginId: "cloudflare",
  rpc: {
    overview,
    tunnelDetails,
    editTunnel,
    create,
    update,
    start,
    stop,
    remove,
    quickList,
    quickCreate,
    quickStart,
    quickStop,
    quickRemove,
    oauthStatus,
    oauthConnect,
    oauthDisconnect,
  },
  command: { status },
  agents: { tools: { shares } },
  setup(bb) {
    setupService(bb);
    setupQuickShares(bb, async () => {
      const { values } = await bb.sdk.plugins.getSettings({ pluginId: bb.pluginId });
      const path = values.cloudflaredPath;
      return typeof path === "string" && path.trim() ? path.trim() : "cloudflared";
    });
  },
});
