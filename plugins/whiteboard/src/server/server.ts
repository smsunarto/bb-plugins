import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { tool } from "./command/tool.ts";
import type { WhiteboardContext } from "./lib/context.ts";
import { createEngine } from "./lib/engine.ts";
import { registerSessionMention } from "./lib/session-mention.ts";
import { createSettings } from "./lib/settings.ts";
import { registerRpc } from "./rpc/contract.ts";
import { registerTools } from "./tools/registry.ts";

export { contract } from "./rpc/contract.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = createSettings(bb);
  const engine = createEngine(bb, settings);
  bb.onDispose(() => engine.dispose());
  const ctx: WhiteboardContext = Object.freeze({ bb, settings, engine });

  registerRpc(ctx);
  bb.cli.register(
    defineCli({
      name: "whiteboard",
      summary: "CLI for the whiteboard plugin",
      commands: { tool: tool(ctx) },
    }),
  );
  registerSessionMention(bb);
  // Awaited so bb waits for the tools before a provider session can list them.
  await registerTools(bb, engine, settings);
}
