import type { Context } from "@bb-kit/core/plugin";
import { definePlugin } from "@bb-kit/core/plugin";
import { runMenuBar } from "./lib/menu-bar.ts";

export default definePlugin({
  pluginId: "pool-bar",
  rpc: {},
  setup({ bb }: Context) {
    bb.background.service("menu-bar", { start: (signal) => runMenuBar(bb, signal) });
  },
});
