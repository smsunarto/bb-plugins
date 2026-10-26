import { definePlugin } from "@bb-kit/core/plugin";
import { HTML_RENDER_PAGE_PATH, isHtmlRenderPageId } from "../shared/html-render.ts";
import {
  PREVIEW_FRAME_HEADERS,
  PREVIEW_FRAME_HTML,
  PREVIEW_FRAME_PATH,
  PREVIEW_FRAME_SANDBOX,
  VIDEO_PLAYER_PATH,
} from "../shared/preview-frame.ts";
import videoPlayerSource, { VIDEO_PLAYER_ETAG } from "../../vendor/video-player.ts";
import { createServices } from "./lib/context.ts";
import { files } from "./lib/instructions.ts";
import {
  parseStateMentionId,
  stateContext,
  WIDGET_STATE_MENTION_PROVIDER,
} from "./lib/widget-state.ts";
import { readState } from "./rpc/read-state.ts";
import { saveState } from "./rpc/save-state.ts";
import { getState } from "./tools/get-state.ts";
import { preview } from "./tools/preview.ts";
import { render } from "./tools/render.ts";

// Opaque origin: page scripts run but cannot reach bb's cookies, storage, or API.
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `sandbox ${PREVIEW_FRAME_SANDBOX}`,
  "x-content-type-options": "nosniff",
  // Published pages never change, so a cached copy stays valid offline.
  "cache-control": "private, max-age=31536000, immutable",
};

export default definePlugin({
  pluginId: "html",
  rpc: { saveState, readState },
  agents: {
    files,
    tools: { render, preview, get_state: getState },
  },
  services: createServices,
  setup({ bb, store, states, requireThread }) {
    // The app reads a page's HTML from here and frames it through `/frame`.
    bb.http.route("GET", HTML_RENDER_PAGE_PATH, (context) => {
      const id = context.req.query("id");
      const html = isHtmlRenderPageId(id) ? store.html(id) : undefined;
      if (html === undefined) {
        return new Response("Page not found", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response(html, { headers: PAGE_HEADERS });
    });
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

    // Deleting a thread deletes the pages it published and the state saved in it.
    bb.events.on("thread.deleted", ({ thread }) => {
      store.deleteThread(thread.id);
      states.deleteThread(thread.id);
    });
  },
});
