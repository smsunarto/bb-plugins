import { definePlugin } from "@bb-kit/core/plugin";

import { registerWorkspaceSignals } from "./lib/workspace-signals.ts";
import { mentionProviders } from "./mentions.ts";
import { renderEmbed } from "./rpc/render-embed.ts";

/**
 * Composer commands ship as skills under `skills/` (bb's `/` menu lists
 * skills, so there is no plugin slash-command surface). Mention providers
 * live in `src/server/mentions.ts`. Smart Embeds are the `::smart-diff` and
 * `::smart-code` message directives backed by the `renderEmbed` RPC.
 */

/**
 * Injected into every agent session. Measured, not guessed: `eval/METRIC.md`
 * defines the score and `eval/RESULTS.md` records the climb. Change it through
 * the harness; `eval/prompts/baseline.md` must stay byte-identical.
 */
export const SMART_EMBED_INSTRUCTIONS = `Use Smart Embeds when a visual diff or an exact code citation makes your answer easier to verify.

For a file changed in the current task, place this leaf directive on its own line in the final response, and give it a line range covering the hunk you are describing, counted on the changed file: ::smart-diff{path="relative/path.ts" start="40" end="72"}

Leave start and end off only when the file is new, or the whole diff runs under about twenty lines: ::smart-diff{path="relative/path.ts"}

To cite existing project code, place this leaf directive on its own line: ::smart-code{path="relative/path.ts" start="12" end="28"}

Use worktree-relative paths. Do not put directives in inline code or fenced code blocks. Add at most six embeds, and only for material files or claims.`;

export default definePlugin({
  pluginId: "kitchen-sink",
  rpc: { renderEmbed },
  setup(bb) {
    for (const provider of mentionProviders) {
      bb.ui.registerMentionProvider(provider);
    }
    registerWorkspaceSignals(bb);
  },
  agents: {
    tools: {},
    instructions() {
      return SMART_EMBED_INSTRUCTIONS;
    },
  },
});
