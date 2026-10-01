import type { Context } from "@bb-kit/core/plugin";
import { definePlugin } from "@bb-kit/core/plugin";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runMenuBar } from "./lib/menu-bar.ts";

export default definePlugin({
  pluginId: "usage-bar",
  rpc: {},
  setup(input: BbPluginApi | Context) {
    // Published bb-kit passes the host. The workspace rewrite wraps it in Context.
    const bb = "bb" in input ? input.bb : input;
    bb.background.service("menu-bar", { start: (signal) => runMenuBar(bb, signal) });
  },
});
