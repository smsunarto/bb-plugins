// @vitest-environment jsdom
// Ported from dev.fast review/app/src/agent-markdown.test.tsx and agent-markdown.browser.test.tsx
// @4ecc570 (MIT). Expectations change only where the Docs TipTap schema renders differently;
// each change is marked "Docs schema".
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentMarkdown,
  MarkdownContent,
  isReactTextNode,
  markdownHasTitle,
} from "./agent-markdown.tsx";

describe("agent markdown", () => {
  it("routes document source links through the supplied peek renderer, including headings and reference links", () => {
    const seen: string[] = [];

    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        source:
          "# [**Save**][source]\n\n[old](review-source:base/file.ts#L1)\n\n[source]: review-source:head/file.ts#L2\n\n[web](https://example.com) [unsafe](javascript:alert(1))",
        renderLink: (href, children) => {
          if (!href.startsWith("review-source:")) return undefined;
          seen.push(href);

          return createElement("button", { type: "button" }, children);
        },
      }),
    );

    expect(seen).toEqual(["review-source:head/file.ts#L2", "review-source:base/file.ts#L1"]);
    expect(html).toContain('<button type="button"><strong>Save</strong></button>');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:");

    const chat = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "[unvalidated](review-source:head/file.ts#L2)",
      }),
    );

    expect(chat).not.toContain("href=");
  });
  it("renders agent answers as GitHub-flavored markdown", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: [
          "**Done**",
          "",
          "- one",
          "- two",
          "",
          "| file | status |",
          "| --- | --- |",
          "| `App.tsx` | fixed |",
          "",
          "```ts",
          "const answer = true;",
          "```",
          "",
          "[Docs](https://example.com/docs)",
        ].join("\n"),
      }),
    );

    expect(html).toContain("<strong>Done</strong>");
    // Docs schema: tight lists carry TipTap's tight-list markers.
    expect(html).toContain('<ul class="tight" data-tight="true">');
    expect(html).toContain("<li><p>one</p></li>");
    // Docs schema: TipTap's table carries its column sizing.
    expect(html).toContain('<table style="min-width:50px">');
    expect(html).toContain("<code>App.tsx</code>");
    // Docs schema: a fence is `<pre><code class="language-ts">`, not upstream's highlighted card.
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain("const answer = true;");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not execute raw html or unsafe markdown links", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: '<script>alert("x")</script>\n\n[run this](javascript:alert("x"))',
      }),
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("run this");
  });

  it("renders local filesystem links as non-clickable code references", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: [
          "[App.test.ts:49](/Users/ketanagrawal/monorepo/repos/dev/packages/review/app/src/App.test.ts:49)",
          "[styles.css](file:///Users/ketanagrawal/monorepo/repos/dev/packages/review/app/src/styles.css)",
        ].join("\n\n"),
      }),
    );

    expect(html).not.toContain("href=");
    expect(html).not.toContain("file://");
    expect(html).not.toContain("/Users/ketanagrawal");
    expect(html).toContain('<code class="agent-markdown-code-reference">App.test.ts:49</code>');
    expect(html).toContain('<code class="agent-markdown-code-reference">styles.css</code>');
  });

  it("highlights quote spans inside markdown paragraphs and inline code", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "We should optimize database queries to avoid latency.",
        highlightQuote: "optimize database queries",
      }),
    );

    expect(html).toContain(
      '<mark class="review-trace-quote-mark">optimize database queries</mark>',
    );
  });

  it("decodes named character references without using DOM innerHTML", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "a &amp; b &gt; c",
      }),
    );

    expect(html).toContain("a &amp; b &gt; c");
  });

  it("keeps the upstream helper exports", () => {
    expect(markdownHasTitle("intro\n\n# Title")).toBe(true);
    expect(markdownHasTitle("## Only a section")).toBe(false);
    expect([isReactTextNode("a"), isReactTextNode(1), isReactTextNode(null)]).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("MarkdownContent", () => {
  let container: HTMLDivElement, root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  const REMOTE = "https://img.example/a.png";

  const render = async (source: string) => {
    await act(async () => root.render(createElement(MarkdownContent, { source })));
  };

  it("renders header cells, without column alignment", async () => {
    await render("| Name | Qty |\n| --- | --: |\n| a | 2 |\n");

    const headers = container.querySelectorAll("th");
    expect(headers).toHaveLength(2);
    // Docs schema: TipTap table cells have no alignment attribute, so `--:` is dropped.
    expect(headers[1]!.getAttribute("style")).toBeNull();
  });

  it("renders a remote image where the document allows one", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () =>
      root.render(
        createElement(MarkdownContent, {
          source: `![A shot](${REMOTE})\n`,
          allowRemoteImages: true,
        }),
      ),
    );

    // Docs schema: TipTap's image is a block node, a sibling of paragraphs, not inside one.
    const image = container.querySelector(".bb-markdown-prose > img");

    expect(image?.getAttribute("alt")).toBe("A shot");
    expect(image?.getAttribute("src")).toBe(REMOTE);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("renders an image as its alt text unless it is an allowed remote one", async () => {
    await render(`![A shot](${REMOTE})\n`);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("em")?.textContent).toBe("A shot");

    // A data URL carries the image itself, which the document never authored.
    await act(async () =>
      root.render(
        createElement(MarkdownContent, {
          source: `![A shot](${PIXEL})\n`,
          allowRemoteImages: true,
        }),
      ),
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("em")?.textContent).toBe("A shot");
  });

  it("renders GFM footnotes with references and definitions", async () => {
    await render("A note[^1].\n\n[^1]: Native pipeline footnote.\n");

    const reference = container.querySelector("a[data-footnote-ref]");
    expect(reference?.getAttribute("href")).toBe("#fn-1");
    expect(container.querySelector("section[data-footnotes] li#fn-1")?.textContent).toContain(
      "Native pipeline footnote.",
    );
  });

  it("renders nothing for an empty source", async () => {
    await render("");

    expect(container.innerHTML).toBe("");
  });
});
