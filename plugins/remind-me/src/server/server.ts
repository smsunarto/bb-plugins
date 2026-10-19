import { definePlugin } from "@bb-kit/core/plugin";
import { prompt } from "./command/prompt.ts";

export default definePlugin({
  pluginId: "remind-me",
  rpc: {},
  command: { prompt },
});
