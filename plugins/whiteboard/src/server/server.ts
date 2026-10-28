import { defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { tool } from "./command/tool.ts";
import type { WhiteboardContext } from "./lib/context.ts";
import { createEngine } from "./lib/engine.ts";
import { registerSessionMention } from "./lib/session-mention.ts";
import { createSettings } from "./lib/settings.ts";
import { registerTools } from "./lib/tools/register.ts";
import { api, apiContract } from "./rpc/api.ts";
import { claimOpen, claimOpenContract } from "./rpc/claim-open.ts";
import { info, infoContract } from "./rpc/info.ts";
import { interest, interestContract } from "./rpc/interest.ts";
import { liveFile, liveFileContract } from "./rpc/live-file.ts";

export const contract = defineRpcContract({
  api: apiContract,
  claimOpen: claimOpenContract,
  info: infoContract,
  interest: interestContract,
  liveFile: liveFileContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = createSettings(bb);
  const engine = createEngine(bb, settings);
  bb.onDispose(() => engine.dispose());
  const ctx: WhiteboardContext = Object.freeze({ bb, settings, engine });

  bb.rpc.register(contract, {
    api: (input) => api(ctx, input),
    claimOpen: (input) => claimOpen(ctx, input),
    info: (input) => info(ctx, input),
    interest: () => interest(ctx),
    liveFile: (input) => liveFile(ctx, input),
  });
  bb.cli.register(
    defineCli({
      name: "whiteboard",
      summary: "CLI for the whiteboard plugin",
      commands: { tool: tool(ctx) },
    }),
  );
  registerSessionMention(bb);
  // Raw registration: names, descriptions and schemas come from the upstream
  // catalog verbatim (design §3.5). Awaited so bb waits for the tools before
  // a provider session can list them.
  await registerTools(bb, engine, settings);
}
