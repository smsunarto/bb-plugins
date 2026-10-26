import { describe, expect, test } from "bun:test";
import {
  htmlRenderDirective,
  injectHtmlRenderBootstrap,
  readHtmlRenderDirective,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "./html-render.ts";

const bootstrapAt = (html: string) =>
  injectHtmlRenderBootstrap(html).indexOf('<style id="html-theme">');

describe("injectHtmlRenderBootstrap", () => {
  test("goes first in an existing head", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    expect(bootstrapAt(html)).toBe(
      html.indexOf("<head>") +
        "<head>".length +
        '<meta charset="utf-8">'.length +
        '<meta name="viewport" content="width=device-width, initial-scale=1">'.length,
    );
  });

  test("ignores a head tag inside a comment or script", () => {
    const html = '<!-- <head> --><script>"<head>"</script><p>Hi</p>';
    const out = injectHtmlRenderBootstrap(html);
    expect(out.startsWith("<!doctype html><head>")).toBe(true);
    expect(out.endsWith(html)).toBe(true);
  });

  test("keeps the page's own charset and viewport", () => {
    const out = injectHtmlRenderBootstrap(
      '<head><meta charset="utf-8"><meta name="viewport" content="width=500"></head>',
    );
    expect(out.match(/charset/g)).toHaveLength(1);
    expect(out.match(/name="viewport"/g)).toHaveLength(1);
  });
});

describe("directive", () => {
  test("round-trips id, title, and clamped height", () => {
    const directive = htmlRenderDirective({
      id: "a".repeat(24),
      title: 'Q3 "plan" {draft}',
      height: 5000,
    });
    expect(directive).toBe(
      `::html-render{id="${"a".repeat(24)}" title="Q3 plan draft" height="2000"}`,
    );
    expect(
      readHtmlRenderDirective({ id: "a".repeat(24), title: "Q3 plan draft", height: "2000" }),
    ).toEqual({
      id: "a".repeat(24),
      title: "Q3 plan draft",
      height: 2000,
    });
  });

  test("rejects a malformed id and tolerates a bad height", () => {
    expect(readHtmlRenderDirective({ id: "../etc" })).toBeUndefined();
    expect(readHtmlRenderDirective({ id: "b".repeat(24), height: "tall" })?.height).toBe(320);
  });
});

describe("frame messages", () => {
  const message = (method: string, params: unknown, id?: string) => ({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });

  test("opens only http and https links", () => {
    expect(
      readHtmlRenderLinkRequest(message("ui/open-link", { url: "https://example.com" }, "1")),
    ).toEqual({
      id: "1",
      url: "https://example.com",
    });
    expect(
      readHtmlRenderLinkRequest(message("ui/open-link", { url: "javascript:alert(1)" }, "1")),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest(message("ui/open-link", { url: "https://example.com" })),
    ).toBeUndefined();
  });

  test("shows only remote or inlined images", () => {
    const open = (src: string) =>
      readHtmlRenderImageRequest(message("html/notifications/open-image", { src }));
    expect(open("data:image/png;base64,AAAA")?.src).toBe("data:image/png;base64,AAAA");
    expect(open("data:text/html,<script>")).toBeUndefined();
    expect(open("javascript:alert(1)")).toBeUndefined();
  });
});
