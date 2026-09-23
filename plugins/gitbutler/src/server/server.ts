import { definePlugin } from "@bb-kit/core/plugin";
import { baseHistory } from "./rpc/base-history.ts";
import { commit } from "./rpc/commit.ts";
import { patch } from "./rpc/patch.ts";
import { repositories } from "./rpc/repositories.ts";
import { workspace } from "./rpc/workspace.ts";

export default definePlugin({
  pluginId: "gitbutler",
  rpc: { repositories, workspace, baseHistory, commit, patch },
});
