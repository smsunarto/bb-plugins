import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { HTML_RENDER_DIRECTIVE, readHtmlRenderDirective } from "../shared/html-render.ts";
import { HtmlRenderFrame } from "./html-render-frame.tsx";
import "./html.css";

function HtmlRenderDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const reference = readHtmlRenderDirective(attributes);
  if (!reference) return <code>{source}</code>;
  // A new id is a different page; never reuse a frame across pages.
  return <HtmlRenderFrame key={reference.id} reference={reference} />;
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: HTML_RENDER_DIRECTIVE, component: HtmlRenderDirective });
});
