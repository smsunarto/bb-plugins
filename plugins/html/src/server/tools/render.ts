import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  clampHtmlRenderHeight,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderDirective,
} from "../../shared/html-render.ts";
import type { HtmlContext } from "../lib/context.ts";
import { files } from "../lib/instructions.ts";
import { html } from "../lib/schema.ts";
import { HtmlRenderPageError, imagesNotFoundError, preparePage } from "../lib/prepare.ts";

const parameters = z.strictObject({
  html,
  title: z.string().min(1).max(HTML_RENDER_MAX_TITLE_LENGTH),
  height: z
    .int()
    .describe(
      `Frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT} to ${HTML_RENDER_MAX_HEIGHT}. Use the contentHeight from html_preview.`,
    ),
});

export function render(ctx: HtmlContext) {
  return {
    name: "html_render",
    ...files.tool("html_render"),
    presentation: {
      label: { pending: "Rendering an HTML page", completed: "Rendered an HTML page" },
    },
    parameters,
    async execute(
      input: z.output<typeof parameters>,
      { threadId, signal }: PluginAgentToolContext,
    ) {
      let prepared: Awaited<ReturnType<typeof preparePage>>;
      try {
        prepared = await preparePage(input.html, ctx.threadFiles(threadId, signal));
      } catch (error) {
        if (error instanceof HtmlRenderPageError) return failure(error.message);
        throw error;
      }
      if (prepared.missing.length > 0)
        return failure(imagesNotFoundError(prepared.missing).message);
      const title = input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML";
      const height = clampHtmlRenderHeight(input.height);
      const id = ctx.store.save({ threadId, title, height, html: prepared.html });
      const directive = htmlRenderDirective({ id, title, height });
      return files.read("html_render_result", { directive });
    },
  };
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
