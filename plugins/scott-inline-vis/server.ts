import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-kit/core/instructions";
import { z } from "zod";
import { absoluteFileSchema, stateContract, widgetIdentitySchema } from "./state-contract.ts";
import {
  PREVIEW_FRAME_HEADERS,
  PREVIEW_FRAME_HTML,
  PREVIEW_FRAME_PATH,
  VIDEO_PLAYER_PATH,
} from "./preview-frame.ts";
import videoPlayerSource, { VIDEO_PLAYER_ETAG } from "./vendor/video-player.ts";
import {
  createWidgetStateStore,
  parseStateMentionId,
  recentStateContext,
  stateContext,
  stateMigrations,
  WIDGET_STATE_MENTION_PROVIDER,
} from "./widget-state.ts";

/** bb's built-in plugin that also claims `::inline-vis`. */
export const BUILTIN_INLINE_VIS_PLUGIN_ID = "inline-vis";

// Agent-facing text, editable in the Prompt Editor plugin.
export const files = instructionFiles(import.meta.url);

export default async function plugin(bb: BbPluginApi) {
  bb.agents.contributeInstructions(() => files.read("inline-vis"));
  const database = bb.storage.database();
  bb.storage.migrate(database, stateMigrations);
  const states = createWidgetStateStore(database);

  async function requireThread(threadId: string): Promise<void> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread || thread.id !== threadId) throw new Error("Thread does not exist");
    } catch (error) {
      throw new Error(
        `Visualization state thread ${JSON.stringify(threadId)} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  bb.http.route(
    "GET",
    PREVIEW_FRAME_PATH,
    () => new Response(PREVIEW_FRAME_HTML, { headers: PREVIEW_FRAME_HEADERS }),
  );
  bb.http.route("GET", VIDEO_PLAYER_PATH, (context) => {
    const headers = { etag: VIDEO_PLAYER_ETAG, "cache-control": "no-cache" };
    if (context.req.header("if-none-match") === VIDEO_PLAYER_ETAG)
      return new Response(null, { status: 304, headers });
    return new Response(videoPlayerSource, {
      headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
    });
  });

  bb.rpc.register(stateContract, {
    async saveState(input) {
      await requireThread(input.threadId);
      return states.save(input);
    },
    async readState(input) {
      await requireThread(input.threadId);
      return states.read(input);
    },
  });

  bb.ui.registerMentionProvider({
    id: WIDGET_STATE_MENTION_PROVIDER,
    label: "Visualization state",
    search({ threadId, query }) {
      return threadId === null ? [] : states.search(threadId, query);
    },
    async resolve(itemId) {
      const identity = parseStateMentionId(itemId);
      await requireThread(identity.threadId);
      const state = states.read(identity);
      if (!state) {
        throw new Error(
          "Saved visualization state is missing. Open the visualization and save it again.",
        );
      }
      return { context: stateContext(state) };
    },
  });

  bb.agents.registerTool({
    name: "inline_vis_get_state",
    ...files.tool("inline_vis_get_state"),
    presentation: {
      label: { pending: "Reading visualization state", completed: "Read visualization state" },
    },
    parameters: z.strictObject({
      file: absoluteFileSchema.optional(),
      messageId: widgetIdentitySchema.shape.messageId.optional(),
    }),
    async execute(input, context) {
      await requireThread(context.threadId);
      return recentStateContext(states.recent(context.threadId, input));
    },
  });
  // bb leaves a directive as literal text when two plugins claim it, so a fresh
  // install turns the built-in renderer off once. Re-enabling it later is the
  // user's choice; update, reload, and restart leave it alone.
  bb.onInstall(async () => {
    await bb.sdk.plugins.disable({ pluginId: BUILTIN_INLINE_VIS_PLUGIN_ID });
  });
}
