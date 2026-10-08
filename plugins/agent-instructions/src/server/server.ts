import { definePlugin } from "@bb-kit/core/plugin";
import { add } from "./command/add.ts";
import { list } from "./command/list.ts";
import { preview } from "./command/preview.ts";
import { remove } from "./command/remove.ts";
import { openStore } from "./lib/store.ts";
import { rules } from "./rpc/rules.ts";
import { saveRules } from "./rpc/save-rules.ts";
import { targets } from "./rpc/targets.ts";

export default definePlugin({
  pluginId: "agent-instructions",
  services: (bb) => ({ store: openStore(bb) }),
  rpc: { rules, saveRules, targets },
  command: { list, add, remove, preview },
  async setup({ bb, store }) {
    await store.load();
    // `configure`, unlike `contributeInstructions`, sees the host, provider,
    // and model a thread resolves with, which is what rules match on.
    bb.agents.configure((session) => {
      const instructions = store.resolve(session.thread.id, session);
      return { tools: [], skills: [], ...(instructions === null ? {} : { instructions }) };
    });
  },
});
