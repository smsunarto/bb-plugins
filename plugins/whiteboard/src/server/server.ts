import { definePlugin } from "@bb-kit/core/plugin";
import { tool } from "./command/tool.ts";
import { createEngine } from "./lib/engine.ts";
import { registerSessionMention } from "./lib/session-mention.ts";
import { createSettings } from "./lib/settings.ts";
import { registerTools } from "./lib/tools/register.ts";
import { api } from "./rpc/api.ts";
import { claimOpen } from "./rpc/claim-open.ts";
import { info } from "./rpc/info.ts";
import { interest } from "./rpc/interest.ts";
import { liveFile } from "./rpc/live-file.ts";

export default definePlugin({
  pluginId: "whiteboard",
  rpc: { api, claimOpen, info, interest, liveFile },
  command: { tool },
  services: (bb) => {
    const settings = createSettings(bb);
    const engine = createEngine(bb, settings);
    bb.onDispose(() => engine.dispose());
    return { settings, engine };
  },
  // Raw registration, not `agents.tools`: names, descriptions and schemas come
  // from the upstream catalog verbatim (design §3.5). Returned so bb waits for
  // the tools before a provider session can list them.
  setup({ bb, engine, settings }) {
    registerSessionMention(bb);
    return registerTools(bb, engine, settings);
  },
});
