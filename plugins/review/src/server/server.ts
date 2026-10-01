import { definePlugin } from "@bb-kit/core/plugin";
import { start } from "./command/start.ts";
import { AUTHOR_INSTRUCTIONS } from "./lib/review.ts";

export default definePlugin({
  pluginId: "review",
  rpc: {},
  command: { start },
  services(bb) {
    const settings = bb.settings.define({
      claudeModel: {
        type: "string",
        label: "Claude reviewer model",
        description: "Reviews work done on OpenAI models.",
        default: "claude-opus-5-5[1m]",
      },
      codexModel: {
        type: "string",
        label: "Codex reviewer model",
        description: "Reviews work done on every other model.",
        default: "gpt-6-astra",
      },
    });
    return { reviewerModels: () => settings.get() };
  },
  setup({ bb }) {
    // A reviewer is this plugin's own spawn, and asking it to review itself
    // would recurse. Side chats answer questions; they do not ship work.
    const skip = new Set([bb.pluginId, "side-chat"]);
    bb.agents.configure((session) => ({
      tools: [],
      skills: [],
      ...(skip.has(session.origin.pluginId ?? "") ? {} : { instructions: AUTHOR_INSTRUCTIONS }),
    }));
  },
});
