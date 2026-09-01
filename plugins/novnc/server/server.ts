import { definePlugin } from "@bb-kit/core/plugin";
import { getNovncStatus } from "./rpc/get-novnc-status.ts";

export default definePlugin({
  pluginId: "novnc",
  rpc: { getNovncStatus },
});
