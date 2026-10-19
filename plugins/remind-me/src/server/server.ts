import { definePlugin } from "@bb-kit/core/plugin";
import { prompt } from "./command/prompt.ts";
import { openStore } from "./lib/store.ts";
import { get } from "./rpc/get.ts";
import { list } from "./rpc/list.ts";
import { save } from "./rpc/save.ts";

export default definePlugin({
  pluginId: "remind-me",
  services: (bb) => ({ store: openStore(bb) }),
  rpc: { get, list, save },
  command: { prompt },
});
