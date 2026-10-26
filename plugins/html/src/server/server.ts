import { definePlugin } from "@bb-kit/core/plugin";
import { HTML_RENDER_PAGE_PATH, isHtmlRenderPageId } from "../shared/html-render.ts";
import { createServices } from "./lib/context.ts";
import { files } from "./lib/instructions.ts";
import { preview } from "./tools/preview.ts";
import { render } from "./tools/render.ts";

// Opaque origin: page scripts run but cannot reach bb's cookies, storage, or API.
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
  "x-content-type-options": "nosniff",
  // Published pages never change, so a cached copy stays valid offline.
  "cache-control": "private, max-age=31536000, immutable",
};

export default definePlugin({
  pluginId: "html",
  rpc: {},
  agents: { files, tools: { render, preview } },
  services: createServices,
  setup({ bb, store }) {
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
    // Deleting a thread deletes the pages it published.
    bb.events.on("thread.deleted", ({ thread }) => store.deleteThread(thread.id));
  },
});
