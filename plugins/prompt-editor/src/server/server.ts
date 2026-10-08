import { definePlugin } from "@bb-kit/core/plugin";
import { file } from "./rpc/file.ts";
import { plugins } from "./rpc/plugins.ts";
import { save } from "./rpc/save.ts";

export default definePlugin({
  pluginId: "prompt-editor",
  rpc: { plugins, file, save },
});
