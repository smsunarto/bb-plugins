import { definePlugin } from "@bb-kit/core/plugin";

import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { renderEmbed } from "./rpc/render-embed.ts";

export const SMART_EMBED_INSTRUCTIONS = `Use Smart Embeds when a visual diff or an exact code citation makes your answer easier to verify.

For a file changed in the current task, place this leaf directive on its own line in the final response: ::smart-diff{path="relative/path.ts"}

To show only part of a large diff, add a line range counted on the changed file: ::smart-diff{path="relative/path.ts" start="40" end="72"}

To cite existing project code, place this leaf directive on its own line: ::smart-code{path="relative/path.ts" start="12" end="28"}

Use worktree-relative paths. Do not put directives in inline code or fenced code blocks. Add at most six embeds, and only for material files or claims.`;

export default definePlugin({
  pluginId: "smart-embeds",
  rpc: { renderEmbed },
  setup(bb) {
    registerWorkspaceSignals(bb);
  },
  agents: {
    tools: {},
    instructions() {
      return SMART_EMBED_INSTRUCTIONS;
    },
  },
});
