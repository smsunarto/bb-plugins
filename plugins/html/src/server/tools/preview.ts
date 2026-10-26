import { defineTool } from "@bb-kit/core/tools";
import type { ToolContext } from "@bb-kit/core/tools";
import { z } from "zod";
import { fragmentDocument, isFragment } from "../../shared/fragment-runtime.ts";
import {
  BB_DEFAULT_THEME_TOKENS,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MEASURE_FONTS,
  htmlRenderTheme,
  injectHtmlRenderBootstrap,
} from "../../shared/html-render.ts";
import { chromeLaunchHint, chromeMissingMessage, findChrome } from "../lib/browser.ts";
import type { HtmlContext } from "../lib/context.ts";
import { captureHtmlScreenshot, HtmlRenderBrowserError } from "../lib/headless-chrome.ts";
import { HtmlRenderPageError, preparePage } from "../lib/prepare.ts";
import { html } from "../lib/schema.ts";

const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1_600;

export const preview = defineTool({
  presentation: {
    label: { pending: "Previewing an HTML page", completed: "Previewed an HTML page" },
  },
  parameters: z.strictObject({
    html,
    width: z
      .int()
      .optional()
      .describe(
        `CSS pixels, ${MIN_PREVIEW_WIDTH} to ${MAX_PREVIEW_WIDTH}. Default ${HTML_RENDER_COLUMN_WIDTH}. Use about 390 for phones.`,
      ),
    appearance: z.enum(["dark", "light"]).optional().describe("Default dark."),
  }),
  async execute(ctx: ToolContext<HtmlContext>, input) {
    const { threadId, signal } = ctx.tool;
    const width = Math.min(
      MAX_PREVIEW_WIDTH,
      Math.max(MIN_PREVIEW_WIDTH, Math.round(input.width ?? HTML_RENDER_COLUMN_WIDTH)),
    );
    const appearance = input.appearance ?? "dark";
    let prepared: Awaited<ReturnType<typeof preparePage>>;
    try {
      prepared = await preparePage(input.html, ctx.threadFiles(threadId, signal));
    } catch (error) {
      if (error instanceof HtmlRenderPageError) return failure(error.message);
      throw error;
    }
    const settings = await ctx.settings.get();
    const executable = await findChrome(settings.chromePath);
    if (executable === undefined) return failure(chromeMissingMessage(settings.chromePath));
    const theme = htmlRenderTheme(
      BB_DEFAULT_THEME_TOKENS[appearance],
      appearance,
      HTML_RENDER_MEASURE_FONTS,
    );
    try {
      const screenshot = await ctx.withBrowser(
        () =>
          captureHtmlScreenshot({
            executable,
            noSandbox: settings.chromeNoSandbox,
            // The runtime the thread will give it: a fragment's, or a document's bootstrap.
            html: isFragment(prepared.html)
              ? fragmentDocument(prepared.html, { token: "preview", theme, state: null })
              : injectHtmlRenderBootstrap(prepared.html, theme),
            width,
            appearance,
            signal,
          }),
        signal,
      );
      const summary = {
        width,
        contentHeight: screenshot.contentHeight,
        capturedHeight: screenshot.capturedHeight,
        consoleMessages: screenshot.consoleMessages,
        ...(prepared.missing.length === 0 ? {} : { missingImages: prepared.missing }),
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary) },
          { type: "image" as const, data: screenshot.png, mimeType: "image/png" },
        ],
      };
    } catch (error) {
      if (!(error instanceof HtmlRenderBrowserError)) throw error;
      const hint = chromeLaunchHint(error.output);
      return failure(hint ? `${error.message} ${hint}` : error.message);
    }
  },
});

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
