import { definePlugin } from "@bb-kit/core/plugin";
import { commitSelection } from "./rpc/commit-selection.ts";
import { repository } from "./rpc/repository.ts";

export default definePlugin({
  pluginId: "gitbutler",
  rpc: { repository, commitSelection },
});
