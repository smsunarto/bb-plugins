import { definePlugin } from "@bb-kit/core/plugin";
import { offerPanelTab } from "./lib/panel-tab.ts";
import { baseHistory } from "./rpc/base-history.ts";
import { branchAction } from "./rpc/branch-action.ts";
import { commit } from "./rpc/commit.ts";
import { patches } from "./rpc/patches.ts";
import { repositories } from "./rpc/repositories.ts";
import { workspace } from "./rpc/workspace.ts";

export default definePlugin({
  pluginId: "gitbutler",
  rpc: { repositories, workspace, baseHistory, commit, patches, branchAction },
  setup(bb) {
    // `active` rather than `created`: a new thread's environment is still
    // provisioning when it is created, so there is no workspace to check yet.
    bb.events.on("thread.active", async ({ thread }) => {
      try {
        await offerPanelTab(bb, thread.id);
      } catch (error) {
        bb.log.warn(`Could not add the GitButler tab to ${thread.id}: ${String(error)}`);
      }
    });
  },
});
